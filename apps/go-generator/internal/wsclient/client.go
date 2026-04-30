// Package wsclient is the generator-side WebSocket client. It dials the
// controller, sends the initial register, dispatches incoming start/stop/ping
// messages to a caller-supplied handler, and pipes per-second metric batches
// back over the same socket. Reconnect-with-backoff is built in; auto-resume
// is NOT — see docs/spec/go-generator.md and the comment on Run below.
//
// The struct is the Go counterpart to apps/node/src/generator/ws-client.ts.
// Where the Node version reads `bufferedAmount` to gauge socket health, we
// rely on a bounded outbound channel and drop-newest at the producer; see
// outbound.go and docs/spec/go-generator.md "Backpressure".
package wsclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/protocol"
	"github.com/Andr0human/hammr-go-generator/internal/scenario"
	"github.com/Andr0human/hammr-go-generator/internal/selfstats"
	"github.com/coder/websocket"
)

// StartHandler runs one test on behalf of the wsclient. It receives the parsed
// start message and a sink to call once per scenario step. Returning means the
// run is finished (natural end, ctx-cancel, or fatal error). Mirrors the
// `runTest` callback site in ws-client.ts.
//
// The handler is responsible for honouring ctx (run-level cancel from the
// controller's `stop` or from the connection dying). It does NOT need to
// flush a tail batch — the wsclient calls flushBatch one more time after the
// handler returns, capturing anything emitted up to the moment of return.
type StartHandler func(ctx context.Context, msg *protocol.StartMsg, sink scenario.EventSink) error

// Options are the wsclient's external dependencies. Everything is required
// except OutboundCapacity / BatchIntervalMs / ReconnectDelays / Logger
// (defaulted) and Stats (optional).
type Options struct {
	ControllerURL    string
	GeneratorID      string
	Cores            int
	MaxVUs           int
	Handler          StartHandler
	Logger           *slog.Logger
	Stats            *selfstats.SelfStats
	OutboundCapacity int             // queued messages, default 64
	BatchIntervalMs  int             // metrics flush cadence, default 1000
	ReconnectDelays  []time.Duration // capped at last entry; default 500ms..10s
}

// activeRun is the lifecycle handle for the test currently running on this
// generator. The wsclient enforces "one test at a time"; subsequent starts
// while one is active get an error reply.
type activeRun struct {
	testID   string
	cancel   context.CancelFunc
	finished chan struct{}
}

type Client struct {
	opts Options
	out  *outbound

	activeMu sync.Mutex
	active   *activeRun

	// eventBuf is the per-test scratch space the per-VU sink appends into. The
	// batcher swaps it out on each tick. A mutex (not channel) keeps the hot
	// path a single Lock/append/Unlock — cheap relative to one HTTP request.
	eventBufMu sync.Mutex
	eventBuf   []protocol.RawEvent

	// Per-test counters reset on each start. Used to assemble DoneStats.
	totalEvents atomic.Int64
	errorsCount atomic.Int64
}

var defaultReconnectDelays = []time.Duration{
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
	5 * time.Second,
	10 * time.Second,
}

func New(opts Options) *Client {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.OutboundCapacity <= 0 {
		opts.OutboundCapacity = 64
	}
	if opts.BatchIntervalMs <= 0 {
		opts.BatchIntervalMs = 1000
	}
	if len(opts.ReconnectDelays) == 0 {
		opts.ReconnectDelays = defaultReconnectDelays
	}
	return &Client{
		opts: opts,
		out:  newOutbound(opts.OutboundCapacity),
	}
}

// QueueDepth reports the number of queued outbound messages. Exposed so
// selfstats can include it as wsBufferedMsgs in each tick. See
// docs/spec/go-generator.md — coder/websocket has no bufferedAmount, so we
// report channel-fill instead. The unit is messages, not bytes.
func (c *Client) QueueDepth() int {
	return len(c.out.ch)
}

// Run is the connection lifecycle. Each iteration dials the controller, runs a
// single connection until it dies, then backs off and retries — UNLESS ctx has
// been cancelled, in which case Run returns nil. We deliberately do not
// auto-resume an in-flight test on reconnect: the controller has already
// marked it failed by the time we reappear (see ws-client.ts comment about
// abort-on-disconnect).
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return nil
		}
		c.opts.Logger.Info("dialing controller",
			"controllerUrl", c.opts.ControllerURL, "attempt", attempt)
		err := c.runOneConnection(ctx)
		if err != nil {
			c.opts.Logger.Warn("connection ended", "err", err.Error(), "attempt", attempt)
		} else {
			// Clean shutdown of a connection. Only happens on parent ctx cancel.
			return nil
		}
		if ctx.Err() != nil {
			return nil
		}
		// Reset to first delay on a connection that lived long enough to be
		// useful — matches the Node version's `attempt = 0` on `open`. We
		// don't have an "open" hook here, so approximate by resetting after
		// any connection that survived the initial dial+register; any error
		// at that stage is still an early failure.
		idx := attempt
		if idx >= len(c.opts.ReconnectDelays) {
			idx = len(c.opts.ReconnectDelays) - 1
		}
		delay := c.opts.ReconnectDelays[idx]
		attempt++
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

func (c *Client) runOneConnection(parent context.Context) error {
	connCtx, cancel := context.WithCancel(parent)
	defer cancel()

	conn, _, err := websocket.Dial(connCtx, c.opts.ControllerURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	// Disable the default 32 MiB read limit; metrics frames stay small but a
	// large response body in a future feature shouldn't trip a hard cap.
	conn.SetReadLimit(-1)

	defer func() {
		// Close with normal status if we're shutting down cleanly; otherwise
		// CloseNow to avoid blocking the reconnect loop on a half-dead peer.
		if parent.Err() != nil {
			_ = conn.Close(websocket.StatusNormalClosure, "client shutdown")
		} else {
			_ = conn.CloseNow()
		}
	}()

	reg := protocol.RegisterMsg{
		Type:        "register",
		GeneratorID: c.opts.GeneratorID,
		Cores:       c.opts.Cores,
		MaxVUs:      c.opts.MaxVUs,
	}
	regBytes, err := json.Marshal(reg)
	if err != nil {
		return fmt.Errorf("marshal register: %w", err)
	}
	regCtx, regCancel := context.WithTimeout(connCtx, 10*time.Second)
	err = conn.Write(regCtx, websocket.MessageText, regBytes)
	regCancel()
	if err != nil {
		return fmt.Errorf("write register: %w", err)
	}
	c.opts.Logger.Info("registered",
		"generatorId", c.opts.GeneratorID,
		"cores", c.opts.Cores, "maxVUs", c.opts.MaxVUs)

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		c.writerLoop(connCtx, conn)
	}()

	readErr := c.readLoop(connCtx, conn)

	// Tear down: stop any active test before waiting on the writer. The
	// connection is going away; the test's metrics path now drops into the
	// outbound buffer (which the writer will fail to flush) and the run-level
	// ctx will release the VU goroutines.
	c.abortActive()

	cancel()
	wg.Wait()
	return readErr
}

func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if typ != websocket.MessageText {
			continue
		}
		msg, err := protocol.DecodeCtlMsg(data)
		if err != nil {
			c.opts.Logger.Warn("decode ctl message", "err", err.Error())
			continue
		}
		switch {
		case msg.Ping != nil:
			c.out.sendBlocking(outboundMsg{Pong: &protocol.PongMsg{Type: "pong"}}, ctx.Done())
		case msg.Start != nil:
			c.handleStart(ctx, msg.Start)
		case msg.Stop != nil:
			c.handleStop(msg.Stop)
		}
	}
}

// writerLoop is the single goroutine allowed to call conn.Write — coder/
// websocket forbids concurrent writes (concurrent read+write is fine). On
// write failure we close the conn so the read loop fails too, unwinding the
// connection cleanly.
func (c *Client) writerLoop(ctx context.Context, conn *websocket.Conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-c.out.ch:
			data, err := encodeOutbound(msg)
			if err != nil {
				c.opts.Logger.Error("encode outbound", "err", err.Error())
				continue
			}
			wctx, wcancel := context.WithTimeout(ctx, 30*time.Second)
			err = conn.Write(wctx, websocket.MessageText, data)
			wcancel()
			if err != nil {
				if ctx.Err() == nil {
					c.opts.Logger.Warn("ws write failed", "err", err.Error())
				}
				_ = conn.CloseNow()
				return
			}
		}
	}
}

func (c *Client) handleStart(connCtx context.Context, msg *protocol.StartMsg) {
	c.activeMu.Lock()
	if c.active != nil {
		busy := c.active.testID
		c.activeMu.Unlock()
		c.out.sendBlocking(outboundMsg{Error: &protocol.ErrorMsg{
			Type:    "error",
			TestID:  msg.TestID,
			Message: fmt.Sprintf("generator already running %s", busy),
		}}, connCtx.Done())
		return
	}

	if msg.VUs == 0 {
		// Zero-VU assignment: the orchestrator dealt us no work. Ack `done`
		// immediately so the per-gen tracker can complete. Mirrors ws-client.ts.
		c.activeMu.Unlock()
		c.out.sendBlocking(outboundMsg{Done: &protocol.DoneMsg{
			Type:   "done",
			TestID: msg.TestID,
			Stats:  protocol.DoneStats{TotalEvents: 0, Errors: 0},
		}}, connCtx.Done())
		c.opts.Logger.Info("zero-VU start; sent done", "testId", msg.TestID)
		return
	}

	testCtx, cancel := context.WithCancel(connCtx)
	run := &activeRun{
		testID:   msg.TestID,
		cancel:   cancel,
		finished: make(chan struct{}),
	}
	c.active = run
	c.activeMu.Unlock()

	// Per-test counter reset.
	c.totalEvents.Store(0)
	c.errorsCount.Store(0)
	c.eventBufMu.Lock()
	c.eventBuf = c.eventBuf[:0]
	c.eventBufMu.Unlock()

	c.opts.Logger.Info("received start",
		"testId", msg.TestID, "vus", msg.VUs,
		"rampUpMs", msg.RampUpMs, "durationMs", msg.DurationMs)

	go c.runActiveTest(connCtx, testCtx, msg, run)
}

func (c *Client) handleStop(msg *protocol.StopMsg) {
	c.activeMu.Lock()
	defer c.activeMu.Unlock()
	if c.active != nil && c.active.testID == msg.TestID {
		c.opts.Logger.Info("received stop; cancelling test", "testId", msg.TestID)
		c.active.cancel()
	}
}

// abortActive is called when the connection is going down. We cancel the
// run-level ctx and wait for the test goroutine to clean up. The test's
// trailing done/error message will hit a dead writer and be dropped — that's
// fine; the controller has already marked the test failed (abort-on-disconnect).
func (c *Client) abortActive() {
	c.activeMu.Lock()
	a := c.active
	c.activeMu.Unlock()
	if a == nil {
		return
	}
	a.cancel()
	<-a.finished
}

func (c *Client) runActiveTest(connCtx, testCtx context.Context, msg *protocol.StartMsg, run *activeRun) {
	defer func() {
		c.activeMu.Lock()
		if c.active == run {
			c.active = nil
		}
		c.activeMu.Unlock()
		close(run.finished)
	}()

	handlerDone := make(chan error, 1)
	go func() {
		handlerDone <- c.opts.Handler(testCtx, msg, c.emit)
	}()

	interval := time.Duration(c.opts.BatchIntervalMs) * time.Millisecond
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var handlerErr error
loop:
	for {
		select {
		case err := <-handlerDone:
			handlerErr = err
			break loop
		case <-ticker.C:
			c.flushBatch(msg.TestID)
		}
	}

	// Final flush. The handler may have emitted events between the last tick
	// and its return; capture them now while the connection is (still) up.
	c.flushBatch(msg.TestID)

	// Tail-flush dropped count if anything piled up after the last metrics
	// frame went out. Use connCtx for cancel — testCtx may already be done.
	if drops := c.out.takeDropped(); drops > 0 {
		d := drops
		c.out.sendBlocking(outboundMsg{Metrics: &protocol.MetricsMsg{
			Type:          "metrics",
			TestID:        msg.TestID,
			Batch:         []protocol.RawEvent{},
			DroppedEvents: &d,
		}}, connCtx.Done())
	}

	// done / error. context.Canceled is the natural-stop case (controller sent
	// `stop`, or connection died and abortActive cancelled testCtx); the test
	// still reports `done` with whatever stats we collected, mirroring
	// ws-client.ts which never converts ctx-abort to `error`.
	if handlerErr != nil && !errors.Is(handlerErr, context.Canceled) {
		c.out.sendBlocking(outboundMsg{Error: &protocol.ErrorMsg{
			Type:    "error",
			TestID:  msg.TestID,
			Message: handlerErr.Error(),
		}}, connCtx.Done())
		c.opts.Logger.Error("test failed",
			"testId", msg.TestID, "err", handlerErr.Error())
	} else {
		stats := protocol.DoneStats{
			TotalEvents: int(c.totalEvents.Load()),
			Errors:      int(c.errorsCount.Load()),
		}
		c.out.sendBlocking(outboundMsg{Done: &protocol.DoneMsg{
			Type:   "done",
			TestID: msg.TestID,
			Stats:  stats,
		}}, connCtx.Done())
		c.opts.Logger.Info("test done; sent done",
			"testId", msg.TestID,
			"totalEvents", stats.TotalEvents,
			"errors", stats.Errors)
	}

	// End-of-test selfstats snapshot mirrors stats.flush() in ws-client.ts so
	// short tests show up in logs.
	if c.opts.Stats != nil {
		c.opts.Stats.Flush()
	}
}

// emit is the EventSink handed to the test handler. It's called from many VU
// goroutines concurrently — the buffer mutex serialises the appends. The
// counters use atomics rather than holding the mutex longer.
func (c *Client) emit(ev protocol.RawEvent) {
	c.eventBufMu.Lock()
	c.eventBuf = append(c.eventBuf, ev)
	c.eventBufMu.Unlock()
	c.totalEvents.Add(1)
	if ev.StatusCode == 0 || ev.StatusCode >= 400 {
		c.errorsCount.Add(1)
	}
	if c.opts.Stats != nil {
		c.opts.Stats.RecordEvents(1)
	}
}

// flushBatch swaps out the event buffer, attaches any pending dropped count,
// and tries to enqueue. On a full outbound channel the batch is dropped (the
// outbound queue restores the count to pendingDropped).
func (c *Client) flushBatch(testID string) {
	c.eventBufMu.Lock()
	var batch []protocol.RawEvent
	if len(c.eventBuf) > 0 {
		batch = c.eventBuf
		// Reuse the underlying capacity for the next window.
		c.eventBuf = make([]protocol.RawEvent, 0, cap(batch))
	}
	c.eventBufMu.Unlock()

	drops := c.out.takeDropped()
	if len(batch) == 0 && drops == 0 {
		return
	}
	m := &protocol.MetricsMsg{Type: "metrics", TestID: testID, Batch: batch}
	if drops > 0 {
		d := drops
		m.DroppedEvents = &d
	}
	if !c.out.trySendMetrics(m) {
		// trySendMetrics has already rolled both len(batch) and *DroppedEvents
		// back into pendingDropped; just record the local stats hit.
		if c.opts.Stats != nil && len(batch) > 0 {
			c.opts.Stats.RecordDropped(len(batch))
		}
	}
}

func encodeOutbound(m outboundMsg) ([]byte, error) {
	switch {
	case m.Metrics != nil:
		return json.Marshal(m.Metrics)
	case m.Done != nil:
		return json.Marshal(m.Done)
	case m.Error != nil:
		return json.Marshal(m.Error)
	case m.Pong != nil:
		return json.Marshal(m.Pong)
	}
	return nil, errors.New("empty outboundMsg")
}
