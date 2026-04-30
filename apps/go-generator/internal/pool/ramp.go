// Package pool spawns and supervises VU goroutines. ramp.go is the pure
// math: it returns per-VU start delays and validates capacity. No goroutines,
// no time — kept side-effect-free so it's trivially testable.
//
// Diverges from apps/node/src/generator/ramp.ts in one place: the round-robin
// thread-assignment helper (assignVUsToThreads) is dropped because the Go
// generator has no thread concept (one goroutine per VU). VUStartDelays is
// kept; ValidateCapacity is collapsed to a single-generator check.
package pool

import "fmt"

// VUStartDelays returns the start delay (ms) for each VU index, spacing them
// evenly across rampUpMs. Mirrors vuStartDelays in ramp.ts: the first VU
// always starts at 0, the last is strictly < rampUpMs, and delays are
// monotonically non-decreasing.
func VUStartDelays(totalVUs int, rampUpMs int) ([]int, error) {
	if totalVUs < 0 {
		return nil, fmt.Errorf("totalVUs must be >= 0, got %d", totalVUs)
	}
	if rampUpMs < 0 {
		return nil, fmt.Errorf("rampUpMs must be >= 0, got %d", rampUpMs)
	}
	if totalVUs == 0 {
		return []int{}, nil
	}
	out := make([]int, totalVUs)
	if rampUpMs == 0 {
		return out, nil
	}
	step := float64(rampUpMs) / float64(totalVUs)
	for i := 0; i < totalVUs; i++ {
		out[i] = roundHalfAwayFromZero(float64(i) * step)
	}
	return out, nil
}

// ValidateCapacity errors out if a single generator was asked to run more VUs
// than its configured max. The Node version checked threadCount × maxPerThread;
// Go's check is just maxVUs, since the goroutine pool is the only ceiling.
func ValidateCapacity(totalVUs, maxVUs int) error {
	if totalVUs > maxVUs {
		return fmt.Errorf(
			"requested %d VUs exceeds capacity (maxVUs=%d). "+
				"Add more generators or raise MAX_VUS.",
			totalVUs, maxVUs,
		)
	}
	return nil
}

// roundHalfAwayFromZero matches JS Math.round (which rounds 0.5 → 1, -0.5 → 0
// — the latter doesn't matter here since inputs are non-negative). Go's
// math.Round is half-away-from-zero too, but we avoid importing math for one
// call and keep the function pure-int.
func roundHalfAwayFromZero(f float64) int {
	if f >= 0 {
		return int(f + 0.5)
	}
	return int(f - 0.5)
}
