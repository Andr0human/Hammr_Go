package wsclient

import (
	"sync/atomic"

	"github.com/Andr0human/hammr-go-generator/internal/protocol"
)

// outbound is the bounded queue between the test-side producers (the per-second
// batcher; ad-hoc sends like done / error / pong) and the per-connection writer
// goroutine. It is the single backpressure point: when the channel is full we
// drop the newest batch and bump pendingDropped — see docs/spec/go-generator.md
// "Backpressure: drop-newest, channel-based" and docs/gotchas.md "Drop-newest,
// not drop-oldest" for why this direction.
//
// The channel is intentionally never closed. The writer goroutine exits on
// ctx.Done(), and any in-flight messages are GC'd with the queue. Closing
// would race with producers (the test goroutine's batcher, the read loop's
// pong reply) that don't share a stop signal with the writer.
type outboundMsg struct {
	Metrics *protocol.MetricsMsg
	Done    *protocol.DoneMsg
	Error   *protocol.ErrorMsg
	Pong    *protocol.PongMsg
}

type outbound struct {
	ch chan outboundMsg
	// pendingDropped is the number of RAW EVENTS dropped since the last metrics
	// message went out. Operator-facing logs report this in event-count terms
	// (not bytes) — that's the honest unit, see docs/spec/go-generator.md.
	pendingDropped atomic.Int64
}

func newOutbound(capacity int) *outbound {
	if capacity < 1 {
		capacity = 1
	}
	return &outbound{ch: make(chan outboundMsg, capacity)}
}

// trySendMetrics is the drop-newest path used by the batcher. Returns true on
// successful enqueue. On a full channel we add the dropped batch's events
// AND any DroppedEvents the batcher attached to pendingDropped, so neither
// counter is lost — the next successful metrics message will carry the full
// running tally to the controller.
func (o *outbound) trySendMetrics(m *protocol.MetricsMsg) bool {
	select {
	case o.ch <- outboundMsg{Metrics: m}:
		return true
	default:
		o.pendingDropped.Add(int64(len(m.Batch)))
		if m.DroppedEvents != nil {
			o.pendingDropped.Add(int64(*m.DroppedEvents))
		}
		return false
	}
}

// sendBlocking is for low-volume, must-deliver messages (done / error / pong).
// They bypass drop-newest because losing a `done` would hang the controller's
// per-gen tracker. cancel is the caller's quit signal so a stuck writer can't
// block shutdown.
func (o *outbound) sendBlocking(msg outboundMsg, cancel <-chan struct{}) bool {
	select {
	case o.ch <- msg:
		return true
	case <-cancel:
		return false
	}
}

// takeDropped returns and resets the pendingDropped counter. The batcher calls
// this when assembling each metrics message so the dropped-event count rides
// out on the next successful frame.
func (o *outbound) takeDropped() int {
	return int(o.pendingDropped.Swap(0))
}
