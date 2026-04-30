// Package vu runs a single virtual user. One goroutine per VU; the goroutine
// re-runs scenario.RunIteration until the run-level context is cancelled.
// Mirrors apps/node/src/generator/vu.ts.
package vu

import (
	"context"
	"math/rand"

	"github.com/Andr0human/hammr-go-generator/internal/scenario"
)

// Context bundles the per-VU identity and scenario. The deadline is carried by
// ctx (use context.WithDeadline / WithTimeout), not a separate endAt field —
// Go idiom diverges from the Node version here.
type Context struct {
	VUID        int
	GeneratorID string
	Scenario    *scenario.Scenario
}

// Run loops scenario iterations until ctx is cancelled or the scenario aborts
// internally. Each iteration starts with a fresh variable map (engine guarantees
// this) so VUs are isolated by construction. Per-VU rng is seeded by the caller
// to keep think-time picks reproducible across ports.
func Run(
	ctx context.Context,
	vc Context,
	doer scenario.HTTPDoer,
	sink scenario.EventSink,
	rng *rand.Rand,
) {
	identity := scenario.VUIdentity{
		GeneratorID: vc.GeneratorID,
		ThreadID:    0, // Go has no thread concept; wire shape kept by emitting 0.
		VUID:        vc.VUID,
	}
	for ctx.Err() == nil {
		// RunIteration is responsible for honouring ctx mid-step. Errors are
		// already surfaced as engine-error events (statusCode=0) inside the
		// engine; we don't propagate them here.
		_ = scenario.RunIteration(ctx, vc.Scenario, doer, sink, identity, rng)
	}
}
