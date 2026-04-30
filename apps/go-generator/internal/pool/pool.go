package pool

import (
	"context"
	"math/rand"
	"sync"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/scenario"
	"github.com/Andr0human/hammr-go-generator/internal/vu"
)

// Config bundles the inputs Run needs. Keep it explicit — no magic env reads
// at this layer; the caller (cmd/generator/main.go) decides where values
// come from.
type Config struct {
	GeneratorID string
	TotalVUs    int
	RampUpMs    int
	DurationMs  int
	Scenario    *scenario.Scenario
	Doer        scenario.HTTPDoer
	Sink        scenario.EventSink
	// Seed for the per-VU rngs. Each VU gets a derived seed so think-time
	// picks are deterministic but uncorrelated across VUs.
	Seed int64
}

// Run spawns one goroutine per VU with staggered start delays, runs the test
// for DurationMs (measured from the call site), and returns once every VU
// goroutine has exited. Cancelling the parent ctx aborts the run early; in
// either case Run blocks until cleanup is complete (no leaked goroutines).
func Run(ctx context.Context, cfg Config) error {
	delays, err := VUStartDelays(cfg.TotalVUs, cfg.RampUpMs)
	if err != nil {
		return err
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.DurationMs)*time.Millisecond)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(cfg.TotalVUs)

	for i, delayMs := range delays {
		go func(vuID, delayMs int) {
			defer wg.Done()
			// Stagger start. If the run is cancelled during the stagger
			// window (short test, long ramp), the VU never starts iterating.
			if delayMs > 0 {
				timer := time.NewTimer(time.Duration(delayMs) * time.Millisecond)
				select {
				case <-runCtx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			rng := rand.New(rand.NewSource(cfg.Seed + int64(vuID)))
			vu.Run(runCtx, vu.Context{
				VUID:        vuID,
				GeneratorID: cfg.GeneratorID,
				Scenario:    cfg.Scenario,
			}, cfg.Doer, cfg.Sink, rng)
		}(i, delayMs)
	}

	wg.Wait()
	return nil
}
