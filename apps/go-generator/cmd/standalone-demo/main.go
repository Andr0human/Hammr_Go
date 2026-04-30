// Standalone demo for Session 2: drives the goroutine pool against a target
// URL without the WebSocket layer. Used to sanity-check the engine + http +
// pool wiring before wsclient lands in Session 3.
//
//	cd apps/go-generator
//	go run ./cmd/standalone-demo -url http://localhost:4000 -vus 50 -duration 30s
//
// Prints aggregate totalEvents, error count, and per-step p50/p99 latency.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"sync"
	"syscall"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/httpclient"
	"github.com/Andr0human/hammr-go-generator/internal/pool"
	"github.com/Andr0human/hammr-go-generator/internal/protocol"
	"github.com/Andr0human/hammr-go-generator/internal/scenario"
)

func main() {
	url := flag.String("url", "http://localhost:4000", "target base URL")
	vus := flag.Int("vus", 50, "virtual users")
	duration := flag.Duration("duration", 30*time.Second, "test duration")
	rampUp := flag.Duration("ramp", 5*time.Second, "ramp-up window")
	flag.Parse()

	sc := &scenario.Scenario{
		Name:    "standalone-demo",
		BaseURL: *url,
		Config: scenario.ScenarioConfig{
			Users:    *vus,
			RampUp:   rampUp.String(),
			Duration: duration.String(),
		},
		Scenario: []scenario.ScenarioStep{
			{Name: "ping", Method: scenario.MethodGET, Path: "/"},
		},
	}

	client := httpclient.New(*vus)

	// Single-writer aggregator goroutine: VU goroutines push events through a
	// channel, one consumer drains. Keeps the hot path lock-free without
	// fighting Go's race detector.
	eventCh := make(chan protocol.RawEvent, 4096)
	var (
		mu       sync.Mutex
		latencies []int
		total    int
		errors   int
	)
	drainerDone := make(chan struct{})
	go func() {
		for ev := range eventCh {
			mu.Lock()
			total++
			latencies = append(latencies, ev.LatencyMs)
			if ev.StatusCode == 0 || ev.StatusCode >= 400 {
				errors++
			}
			mu.Unlock()
		}
		close(drainerDone)
	}()

	sink := func(ev protocol.RawEvent) {
		// Non-blocking: drop on overflow rather than back-pressuring a VU.
		// Demo only — production has the wsclient outbound buffer for this.
		select {
		case eventCh <- ev:
		default:
		}
	}

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	baselineGoroutines := runtime.NumGoroutine()
	startWall := time.Now()
	log.Printf("starting: %d VUs, ramp=%s, duration=%s, target=%s",
		*vus, rampUp, duration, *url)

	if err := pool.Run(rootCtx, pool.Config{
		GeneratorID: "standalone-demo",
		TotalVUs:    *vus,
		RampUpMs:    int(rampUp.Milliseconds()),
		DurationMs:  int(duration.Milliseconds()),
		Scenario:    sc,
		Doer:        client,
		Sink:        sink,
		Seed:        time.Now().UnixNano(),
	}); err != nil {
		log.Fatalf("pool.Run: %v", err)
	}
	close(eventCh)
	<-drainerDone

	elapsed := time.Since(startWall)
	p50, p99 := percentiles(latencies)
	rps := float64(total) / elapsed.Seconds()

	fmt.Printf("\n--- results ---\n")
	fmt.Printf("elapsed      %s\n", elapsed.Round(time.Millisecond))
	fmt.Printf("totalEvents  %d\n", total)
	fmt.Printf("errors       %d (%.2f%%)\n", errors, 100*float64(errors)/maxFloat(float64(total), 1))
	fmt.Printf("throughput   %.1f req/s\n", rps)
	fmt.Printf("latency p50  %d ms\n", p50)
	fmt.Printf("latency p99  %d ms\n", p99)

	// Goroutine-leak check: give the runtime ~1 s to reap, then compare.
	time.Sleep(1 * time.Second)
	leaked := runtime.NumGoroutine() - baselineGoroutines
	fmt.Printf("goroutines   baseline=%d, post-run=%d (delta=%+d)\n",
		baselineGoroutines, runtime.NumGoroutine(), leaked)
	if leaked > 2 {
		// Allow tiny slack for runtime-internal goroutines that fluctuate.
		fmt.Fprintf(os.Stderr, "warning: %d goroutines may have leaked\n", leaked)
	}
}

func percentiles(xs []int) (p50, p99 int) {
	if len(xs) == 0 {
		return 0, 0
	}
	sorted := make([]int, len(xs))
	copy(sorted, xs)
	sort.Ints(sorted)
	return sorted[len(sorted)*50/100], sorted[len(sorted)*99/100]
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
