// Package selfstats samples per-process telemetry on a fixed cadence and emits
// it as one structured log line per window. Mirrors apps/node/src/self-stats.ts
// in cadence and field names where the underlying signals translate; Go-only
// signals (gcPauseP99Ms, goroutineCount) are added on top. See
// docs/spec/go-generator.md "Self-instrumentation" for the Node↔Go field
// mapping and why Go has no "loop lag".
//
// Lifecycle: caller constructs with New, runs Run(ctx) on its own goroutine
// (typically tracked by the top-level WaitGroup in cmd/generator/main.go).
// Run ticks until ctx.Done(), emits one final flush snapshot, then returns —
// no separate Stop() needed.
package selfstats

import (
	"context"
	"log/slog"
	"math"
	"runtime"
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
)

const (
	schedLatName = "/sched/latencies:seconds"
	gcPauseName  = "/gc/pauses:seconds"
	heapObjsName = "/memory/classes/heap/objects:bytes"

	defaultIntervalMs = 60_000
)

// cpuTimes is a small POD shared by the OS-specific files. Values are
// monotonically increasing per-process CPU time in nanoseconds.
type cpuTimes struct {
	UserNs int64
	SysNs  int64
}

// Snapshot is what tick() returns and what gets logged. Field names track the
// Node version where signals correspond; Go-specific extras carry the "go" /
// "gc" prefix so a grep over mixed Node+Go logs still matches sensibly.
type Snapshot struct {
	WindowSec      float64
	Events         int64
	Dropped        int64
	RPS            float64
	SchedLatP50Ms  float64
	SchedLatP99Ms  float64
	SchedLatMaxMs  float64
	GCPauseP99Ms   float64
	GoHeapInUseMB  float64
	GoroutineCount int
	RSSMB          float64
	CPUUserPct     float64
	CPUSysPct      float64
}

// Options bundles all the inputs New needs. Component names the per-process
// identity (e.g. "generator:go-gen-1") and is included in every log line so
// stdout from multiple processes is grep-able by source. Extra is evaluated
// lazily at tick time so values like wsBufferedBytes and activeTestId reflect
// the moment of emission, not the moment of construction.
type Options struct {
	Component  string
	Logger     *slog.Logger
	IntervalMs int
	Extra      func() map[string]any
}

type SelfStats struct {
	component string
	logger    *slog.Logger
	interval  time.Duration
	extra     func() map[string]any

	// Hot-path counters — bumped from VU goroutines (RecordEvents) and the
	// outbound writer (RecordDropped). Atomic to avoid a mutex on a path that
	// fires per metrics batch.
	events  atomic.Int64
	dropped atomic.Int64

	// Tick-time state, only touched from the loop goroutine after construction.
	mu          sync.Mutex
	samples     []metrics.Sample
	prevSched   *metrics.Float64Histogram
	prevGC      *metrics.Float64Histogram
	prevCPU     cpuTimes
	windowStart time.Time
}

// New constructs a SelfStats. It does NOT start sampling — call Run(ctx) on a
// dedicated goroutine.
func New(opts Options) *SelfStats {
	intervalMs := opts.IntervalMs
	if intervalMs <= 0 {
		intervalMs = defaultIntervalMs
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &SelfStats{
		component: opts.Component,
		logger:    logger,
		interval:  time.Duration(intervalMs) * time.Millisecond,
		extra:     opts.Extra,
		samples: []metrics.Sample{
			{Name: schedLatName},
			{Name: gcPauseName},
			{Name: heapObjsName},
		},
	}
}

// RecordEvents bumps the per-window event counter. Call from the metric-emit
// path (one batch = one call with batch length). Cheap atomic add; safe from
// any goroutine.
func (s *SelfStats) RecordEvents(n int) {
	if n > 0 {
		s.events.Add(int64(n))
	}
}

// RecordDropped bumps the per-window drop counter. Call when the outbound
// channel rejects a batch. Mirrors Node's recordDropped.
func (s *SelfStats) RecordDropped(n int) {
	if n > 0 {
		s.dropped.Add(int64(n))
	}
}

// Run samples on a ticker until ctx is cancelled, then emits one final
// snapshot and returns. Designed to live inside a top-level sync.WaitGroup —
// when this returns, the loop goroutine is fully cleaned up.
func (s *SelfStats) Run(ctx context.Context) {
	s.mu.Lock()
	s.windowStart = time.Now()
	s.prevCPU = readCPUTimes()
	// Prime the histogram baselines so the first tick reports a delta from
	// process start. Without this, the first window double-counts because
	// runtime/metrics histograms are cumulative.
	metrics.Read(s.samples)
	if h := s.samples[0].Value.Float64Histogram(); h != nil {
		s.prevSched = cloneHistogram(h)
	}
	if h := s.samples[1].Value.Float64Histogram(); h != nil {
		s.prevGC = cloneHistogram(h)
	}
	s.mu.Unlock()

	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			s.tick("shutdown")
			return
		case <-t.C:
			s.tick("interval")
		}
	}
}

// Flush emits a snapshot immediately. Useful at end-of-test for short runs
// that never cross the per-minute boundary. Mirrors Node's flush().
func (s *SelfStats) Flush() Snapshot {
	return s.tick("flush")
}

func (s *SelfStats) tick(reason string) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	windowMs := now.Sub(s.windowStart).Milliseconds()
	if windowMs < 1 {
		windowMs = 1
	}
	windowSec := float64(windowMs) / 1000.0

	currCPU := readCPUTimes()
	cpuUserPct := pctOfCore(currCPU.UserNs-s.prevCPU.UserNs, windowMs)
	cpuSysPct := pctOfCore(currCPU.SysNs-s.prevCPU.SysNs, windowMs)

	metrics.Read(s.samples)
	schedDelta := histDelta(s.samples[0].Value.Float64Histogram(), s.prevSched)
	gcDelta := histDelta(s.samples[1].Value.Float64Histogram(), s.prevGC)
	heapBytes := s.samples[2].Value.Uint64()

	rssBytes := readRSSBytes()

	events := s.events.Swap(0)
	dropped := s.dropped.Swap(0)

	snap := Snapshot{
		WindowSec:      round2(windowSec),
		Events:         events,
		Dropped:        dropped,
		RPS:            round1(float64(events) / windowSec),
		SchedLatP50Ms:  round2(secToMs(histPercentile(schedDelta, 0.50))),
		SchedLatP99Ms:  round2(secToMs(histPercentile(schedDelta, 0.99))),
		SchedLatMaxMs:  round2(secToMs(histMax(schedDelta))),
		GCPauseP99Ms:   round2(secToMs(histPercentile(gcDelta, 0.99))),
		GoHeapInUseMB:  round1(float64(heapBytes) / 1024 / 1024),
		GoroutineCount: runtime.NumGoroutine(),
		RSSMB:          round1(float64(rssBytes) / 1024 / 1024),
		CPUUserPct:     round1(cpuUserPct),
		CPUSysPct:      round1(cpuSysPct),
	}

	attrs := []any{
		slog.String("component", s.component),
		slog.String("reason", reason),
		slog.Float64("windowSec", snap.WindowSec),
		slog.Int64("events", snap.Events),
		slog.Int64("dropped", snap.Dropped),
		slog.Float64("rps", snap.RPS),
		slog.Float64("schedLatP50Ms", snap.SchedLatP50Ms),
		slog.Float64("schedLatP99Ms", snap.SchedLatP99Ms),
		slog.Float64("schedLatMaxMs", snap.SchedLatMaxMs),
		slog.Float64("gcPauseP99Ms", snap.GCPauseP99Ms),
		slog.Float64("goHeapInUseMB", snap.GoHeapInUseMB),
		slog.Int("goroutineCount", snap.GoroutineCount),
		slog.Float64("rssMB", snap.RSSMB),
		slog.Float64("cpuUserPct", snap.CPUUserPct),
		slog.Float64("cpuSysPct", snap.CPUSysPct),
	}
	if s.extra != nil {
		for k, v := range s.extra() {
			attrs = append(attrs, slog.Any(k, v))
		}
	}
	s.logger.LogAttrs(context.Background(), slog.LevelInfo, "self-stats", toAttrs(attrs)...)

	// Reset window baselines.
	if h := s.samples[0].Value.Float64Histogram(); h != nil {
		s.prevSched = cloneHistogram(h)
	}
	if h := s.samples[1].Value.Float64Histogram(); h != nil {
		s.prevGC = cloneHistogram(h)
	}
	s.prevCPU = currCPU
	s.windowStart = now
	return snap
}

// toAttrs converts a slog-style ...any slice (already alternating attrs) into
// the strongly typed []slog.Attr LogAttrs requires. We build the slice with
// slog.String/Int/Float64 helpers — every element is already a slog.Attr.
func toAttrs(parts []any) []slog.Attr {
	out := make([]slog.Attr, 0, len(parts))
	for _, p := range parts {
		if a, ok := p.(slog.Attr); ok {
			out = append(out, a)
		}
	}
	return out
}

func pctOfCore(deltaNs int64, windowMs int64) float64 {
	if windowMs <= 0 {
		return 0
	}
	return (float64(deltaNs) / 1_000_000.0) / float64(windowMs) * 100.0
}

func secToMs(seconds float64) float64 { return seconds * 1000.0 }

func round1(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*10) / 10
}

func round2(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

// cloneHistogram copies the runtime/metrics histogram. metrics.Read returns
// pointers backed by storage it reuses across calls — we MUST clone before
// stashing as a baseline or the next Read overwrites the "previous" snapshot.
func cloneHistogram(h *metrics.Float64Histogram) *metrics.Float64Histogram {
	if h == nil {
		return nil
	}
	counts := make([]uint64, len(h.Counts))
	copy(counts, h.Counts)
	buckets := make([]float64, len(h.Buckets))
	copy(buckets, h.Buckets)
	return &metrics.Float64Histogram{Counts: counts, Buckets: buckets}
}

// histDelta returns curr - prev bucket-wise, assuming identical bucket
// boundaries (runtime/metrics promises this for a given metric across a
// single process lifetime). Returns nil when curr is nil.
func histDelta(curr, prev *metrics.Float64Histogram) *metrics.Float64Histogram {
	if curr == nil {
		return nil
	}
	if prev == nil {
		return curr
	}
	counts := make([]uint64, len(curr.Counts))
	for i := range curr.Counts {
		c := curr.Counts[i]
		if i < len(prev.Counts) {
			// Histograms are monotonically non-decreasing per bucket, but if
			// the runtime ever resets one we'd underflow uint64. Guard anyway.
			if c >= prev.Counts[i] {
				counts[i] = c - prev.Counts[i]
			}
		} else {
			counts[i] = c
		}
	}
	return &metrics.Float64Histogram{Counts: counts, Buckets: curr.Buckets}
}

// histPercentile returns the upper-bucket boundary at percentile p (0..1).
// Buckets[i+1] is the right edge of the i'th bucket. Returns 0 for an empty
// histogram. The last bucket has +Inf as its right edge in runtime/metrics —
// fall back to the left edge in that case so we don't print "+Inf ms".
func histPercentile(h *metrics.Float64Histogram, p float64) float64 {
	if h == nil {
		return 0
	}
	var total uint64
	for _, c := range h.Counts {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := uint64(math.Ceil(float64(total) * p))
	if target == 0 {
		target = 1
	}
	var cum uint64
	for i, c := range h.Counts {
		cum += c
		if cum >= target {
			right := h.Buckets[i+1]
			if math.IsInf(right, 1) {
				return h.Buckets[i]
			}
			return right
		}
	}
	return 0
}

// histMax returns the right edge of the highest bucket with a non-zero count.
// Same +Inf guard as histPercentile.
func histMax(h *metrics.Float64Histogram) float64 {
	if h == nil {
		return 0
	}
	for i := len(h.Counts) - 1; i >= 0; i-- {
		if h.Counts[i] > 0 {
			right := h.Buckets[i+1]
			if math.IsInf(right, 1) {
				return h.Buckets[i]
			}
			return right
		}
	}
	return 0
}
