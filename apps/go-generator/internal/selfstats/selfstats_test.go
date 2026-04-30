package selfstats

import (
	"math"
	"runtime/metrics"
	"testing"
)

// Histogram math is the only piece of selfstats that's testable without OS
// hooks. The procstats_*.go files and the runtime/metrics path are exercised
// end-to-end by the session-3 demo run; here we just nail down percentile and
// delta semantics so a refactor doesn't silently break them.

func makeHist(buckets []float64, counts []uint64) *metrics.Float64Histogram {
	return &metrics.Float64Histogram{Buckets: buckets, Counts: counts}
}

func TestHistPercentile(t *testing.T) {
	t.Run("nil and empty return 0", func(t *testing.T) {
		if got := histPercentile(nil, 0.5); got != 0 {
			t.Fatalf("nil hist: want 0, got %v", got)
		}
		empty := makeHist([]float64{0, 1, 2}, []uint64{0, 0})
		if got := histPercentile(empty, 0.99); got != 0 {
			t.Fatalf("empty hist: want 0, got %v", got)
		}
	})

	t.Run("p50 lands in the bucket holding the median", func(t *testing.T) {
		h := makeHist([]float64{0, 1, 2, 3}, []uint64{10, 0, 0})
		// All counts in bucket [0,1); upper bound = 1.
		if got := histPercentile(h, 0.50); got != 1 {
			t.Fatalf("want 1, got %v", got)
		}
	})

	t.Run("p99 picks the right tail bucket", func(t *testing.T) {
		// 95 in [0,1), 4 in [1,2), 1 in [2,3). p99 by ceil-rank lands on the
		// 99th observation, which sits in bucket [1,2) — upper bound 2. The
		// straggler in [2,3) is the p100 / max, exercised in TestHistMax.
		h := makeHist([]float64{0, 1, 2, 3}, []uint64{95, 4, 1})
		if got := histPercentile(h, 0.99); got != 2 {
			t.Fatalf("want 2, got %v", got)
		}
	})

	t.Run("+Inf upper bucket falls back to left edge", func(t *testing.T) {
		h := makeHist([]float64{0, 1, math.Inf(1)}, []uint64{0, 5})
		// Sole non-empty bucket is [1, +Inf); we should not return +Inf.
		got := histPercentile(h, 0.99)
		if math.IsInf(got, 0) {
			t.Fatalf("returned infinity")
		}
		if got != 1 {
			t.Fatalf("want left edge 1, got %v", got)
		}
	})
}

func TestHistDelta(t *testing.T) {
	t.Run("nil prev returns curr unchanged", func(t *testing.T) {
		curr := makeHist([]float64{0, 1, 2}, []uint64{3, 5})
		got := histDelta(curr, nil)
		if got != curr {
			t.Fatalf("want same pointer, got different")
		}
	})

	t.Run("subtracts buckets monotonically", func(t *testing.T) {
		prev := makeHist([]float64{0, 1, 2}, []uint64{3, 5})
		curr := makeHist([]float64{0, 1, 2}, []uint64{8, 10})
		got := histDelta(curr, prev)
		want := []uint64{5, 5}
		if len(got.Counts) != len(want) {
			t.Fatalf("len mismatch: %v", got.Counts)
		}
		for i := range want {
			if got.Counts[i] != want[i] {
				t.Fatalf("bucket %d: want %d, got %d", i, want[i], got.Counts[i])
			}
		}
	})

	t.Run("guards against underflow if prev > curr", func(t *testing.T) {
		// Shouldn't happen with cumulative histograms, but if it ever did the
		// uint64 subtraction would wrap to a huge value and corrupt every
		// downstream percentile. We clamp to 0 instead.
		prev := makeHist([]float64{0, 1, 2}, []uint64{10, 0})
		curr := makeHist([]float64{0, 1, 2}, []uint64{5, 0})
		got := histDelta(curr, prev)
		if got.Counts[0] != 0 {
			t.Fatalf("want 0 (clamped), got %d", got.Counts[0])
		}
	})
}

func TestHistMax(t *testing.T) {
	h := makeHist([]float64{0, 1, 2, 3}, []uint64{1, 0, 1})
	if got := histMax(h); got != 3 {
		t.Fatalf("want 3, got %v", got)
	}
	empty := makeHist([]float64{0, 1, 2}, []uint64{0, 0})
	if got := histMax(empty); got != 0 {
		t.Fatalf("want 0 for empty, got %v", got)
	}
}
