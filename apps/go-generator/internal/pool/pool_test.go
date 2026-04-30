package pool

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/httpclient"
	"github.com/Andr0human/hammr-go-generator/internal/protocol"
	"github.com/Andr0human/hammr-go-generator/internal/scenario"
)

// TestPool_RunsAgainstHTTPTestServer verifies the engine + httpclient + pool
// wiring end-to-end against an in-process test server, without requiring the
// Node echo-server. Also checks the goroutine-leak invariant from
// docs/build-plan.md Session 2.
func TestPool_RunsAgainstHTTPTestServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))

	sc := &scenario.Scenario{
		Name:    "test",
		BaseURL: srv.URL,
		Config:  scenario.ScenarioConfig{},
		Scenario: []scenario.ScenarioStep{
			{Name: "ping", Method: scenario.MethodGET, Path: "/"},
		},
	}

	var total atomic.Int64
	sink := func(ev protocol.RawEvent) {
		if ev.StatusCode == 200 {
			total.Add(1)
		}
	}

	client := httpclient.New(8)

	// Warm the http stack so the baseline includes its persistent goroutines
	// (idle-conn readers etc.) — otherwise the delta would attribute them to
	// the VU pool.
	warmReq, _ := http.NewRequest("GET", srv.URL+"/", nil)
	if resp, err := client.Do(warmReq); err == nil {
		_ = resp.Body.Close()
	}
	time.Sleep(50 * time.Millisecond)
	baseline := runtime.NumGoroutine()

	cfg := Config{
		GeneratorID: "t",
		TotalVUs:    8,
		RampUpMs:    100,
		DurationMs:  500,
		Scenario:    sc,
		Doer:        client,
		Sink:        sink,
		Seed:        1,
	}
	if err := Run(context.Background(), cfg); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if total.Load() == 0 {
		t.Fatalf("expected non-zero events, got 0")
	}

	// Tear down server + idle conns before measuring so any lingering count
	// is VU-side, not http-stack-side.
	srv.Close()
	client.Transport.(*http.Transport).CloseIdleConnections()
	time.Sleep(300 * time.Millisecond)
	delta := runtime.NumGoroutine() - baseline
	if delta > 2 {
		t.Errorf("goroutine leak suspected: baseline=%d, post=%d (delta=%d)",
			baseline, runtime.NumGoroutine(), delta)
	}
}

func TestPool_CancellationStopsEarly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	sc := &scenario.Scenario{
		BaseURL: srv.URL,
		Scenario: []scenario.ScenarioStep{
			{Name: "ping", Method: scenario.MethodGET, Path: "/"},
		},
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	err := Run(ctx, Config{
		GeneratorID: "t",
		TotalVUs:    4,
		RampUpMs:    0,
		DurationMs:  10_000, // would run 10s if not cancelled
		Scenario:    sc,
		Doer:        httpclient.New(4),
		Sink:        func(protocol.RawEvent) {},
		Seed:        1,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("Run did not honour cancellation: elapsed=%s", elapsed)
	}
}
