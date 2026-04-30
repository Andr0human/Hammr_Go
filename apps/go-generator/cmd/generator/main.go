// Command generator is the Go-side load generator. It dials the Node
// controller over WebSocket, registers, and runs scenarios on demand.
//
// Usage:
//
//	CONTROLLER_URL=ws://localhost:3001/gen \
//	GENERATOR_ID=go-gen-1 \
//	MAX_VUS=512 \
//	go run ./cmd/generator
//
// Env vars (all optional except where noted):
//
//	CONTROLLER_URL   ws URL of the controller's gen-WS endpoint
//	                 (default: ws://localhost:3001/gen)
//	GENERATOR_ID     identity advertised in `register` (default: gen-XXXXXXXX
//	                 with 4 random bytes)
//	MAX_VUS          capacity reported to the controller; sizes the HTTP
//	                 client's idle-conn pool (default: NumCPU * 128)
//	OUTBOUND_CAPACITY queued messages between batcher and writer; drop-newest
//	                 kicks in past this (default: 64)
//	BATCH_INTERVAL_MS metrics flush cadence (default: 1000)
//
// See docs/build-plan.md → "Session 3" and docs/spec/go-generator.md for the
// design rationale; this file is the wiring, not the algorithms.
package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/httpclient"
	"github.com/Andr0human/hammr-go-generator/internal/pool"
	"github.com/Andr0human/hammr-go-generator/internal/protocol"
	"github.com/Andr0human/hammr-go-generator/internal/scenario"
	"github.com/Andr0human/hammr-go-generator/internal/selfstats"
	"github.com/Andr0human/hammr-go-generator/internal/wsclient"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	controllerURL := envString("CONTROLLER_URL", "ws://localhost:3001/gen")
	generatorID := envString("GENERATOR_ID", autoGenID())
	cores := runtime.NumCPU()
	maxVUs := envInt("MAX_VUS", cores*128, logger)
	outCap := envInt("OUTBOUND_CAPACITY", 64, logger)
	batchMs := envInt("BATCH_INTERVAL_MS", 1000, logger)

	component := "generator:" + generatorID
	// wsclient logs need the component attached via With so every line carries
	// it. selfstats adds its OWN component attr in tick(), so it gets the bare
	// base logger — passing compLogger to it would produce duplicate
	// "component" keys in the JSON output.
	compLogger := logger.With("component", component)

	// Top-level cancel: SIGINT/SIGTERM both unwind the WaitGroup. Defer the
	// `stop` so we restore default signal handling when main returns —
	// otherwise a second Ctrl+C wouldn't kill a stuck process.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	httpClient := httpclient.New(maxVUs)

	// `client` is captured by the selfstats Extra closure for the wsBufferedMsgs
	// field. Declared before the selfstats / client constructions so the
	// closure can reach it via reference even though the value is set later.
	var client *wsclient.Client
	stats := selfstats.New(selfstats.Options{
		Component: component,
		Logger:    logger,  // bare; selfstats adds component itself
		Extra: func() map[string]any {
			depth := 0
			if client != nil {
				depth = client.QueueDepth()
			}
			return map[string]any{
				"wsBufferedMsgs": depth,
			}
		},
	})

	handler := func(ctx context.Context, msg *protocol.StartMsg, sink scenario.EventSink) error {
		parsed, err := scenario.ParseScenario(msg.Scenario)
		if err != nil {
			return fmt.Errorf("parse scenario: %w", err)
		}
		// VU and duration come from the controller's start message, not the
		// scenario config. The scenario carries shape + steps; the orchestrator
		// owns pacing — this matches Node's runTest signature.
		cfg := pool.Config{
			GeneratorID: generatorID,
			TotalVUs:    msg.VUs,
			RampUpMs:    msg.RampUpMs,
			DurationMs:  msg.DurationMs,
			Scenario:    &parsed.Scenario,
			Doer:        httpClient,
			Sink:        sink,
			Seed:        time.Now().UnixNano(),
		}
		return pool.Run(ctx, cfg)
	}

	client = wsclient.New(wsclient.Options{
		ControllerURL:    controllerURL,
		GeneratorID:      generatorID,
		Cores:            cores,
		MaxVUs:           maxVUs,
		Handler:          handler,
		Logger:           compLogger,
		Stats:            stats,
		OutboundCapacity: outCap,
		BatchIntervalMs:  batchMs,
	})

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		stats.Run(ctx)
	}()
	go func() {
		defer wg.Done()
		if err := client.Run(ctx); err != nil {
			logger.Error("wsclient.Run returned error", "err", err.Error())
		}
	}()

	compLogger.Info("generator started",
		"generatorId", generatorID,
		"cores", cores,
		"maxVUs", maxVUs,
		"controllerUrl", controllerURL,
		"outboundCapacity", outCap,
		"batchIntervalMs", batchMs)

	wg.Wait()
	compLogger.Info("generator shutdown complete")
}

func envString(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int, logger *slog.Logger) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		logger.Warn("env var ignored; using default",
			"key", key, "value", v, "default", fallback)
		return fallback
	}
	return n
}

// autoGenID picks a default generatorId when none is supplied. 4 random bytes
// (32 bits, hex-encoded) is plenty for distinguishing concurrent generators in
// a single deployment without coordinating with the controller.
func autoGenID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand.Read effectively never fails outside genuinely broken
		// hosts. Fall back to a wall-clock id rather than aborting startup.
		return fmt.Sprintf("gen-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("gen-%x", b)
}
