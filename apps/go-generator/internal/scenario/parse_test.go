package scenario

import (
	"encoding/json"
	"strings"
	"testing"
)

// validRaw mirrors the TS parse.test.ts fixture. Authored as a Go map so
// every test case can shallow-merge fields onto it.
func validRaw() map[string]any {
	return map[string]any{
		"name":    "Demo",
		"baseUrl": "http://localhost:4000",
		"config":  map[string]any{"users": 10, "rampUp": "5s", "duration": "30s"},
		"scenario": []any{
			map[string]any{"name": "Ping", "method": "GET", "path": "/"},
		},
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestParseScenario(t *testing.T) {
	t.Run("accepts a minimal valid scenario and resolves durations", func(t *testing.T) {
		p, err := ParseScenario(mustMarshal(t, validRaw()))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.RampUpMs != 5000 {
			t.Errorf("rampUpMs = %d, want 5000", p.RampUpMs)
		}
		if p.DurationMs != 30000 {
			t.Errorf("durationMs = %d, want 30000", p.DurationMs)
		}
		if p.Scenario.Name != "Demo" {
			t.Errorf("name = %q, want Demo", p.Scenario.Name)
		}
		if len(p.Scenario.Scenario) != 1 {
			t.Errorf("steps = %d, want 1", len(p.Scenario.Scenario))
		}
	})

	t.Run("rejects duration <= rampUp", func(t *testing.T) {
		raw := validRaw()
		raw["config"] = map[string]any{"users": 10, "rampUp": "30s", "duration": "30s"}
		_, err := ParseScenario(mustMarshal(t, raw))
		if err == nil || !strings.Contains(err.Error(), "greater than rampUp") {
			t.Fatalf("want 'greater than rampUp' error, got %v", err)
		}
	})

	t.Run("rejects a baseUrl without http(s) scheme", func(t *testing.T) {
		raw := validRaw()
		raw["baseUrl"] = "localhost:4000"
		if _, err := ParseScenario(mustMarshal(t, raw)); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("rejects scenarios with no steps", func(t *testing.T) {
		raw := validRaw()
		raw["scenario"] = []any{}
		if _, err := ParseScenario(mustMarshal(t, raw)); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("rejects duplicate step names", func(t *testing.T) {
		raw := validRaw()
		raw["scenario"] = []any{
			map[string]any{"name": "Ping", "method": "GET", "path": "/"},
			map[string]any{"name": "Ping", "method": "GET", "path": "/again"},
		}
		_, err := ParseScenario(mustMarshal(t, raw))
		if err == nil || !strings.Contains(err.Error(), "duplicate step name") {
			t.Fatalf("want 'duplicate step name' error, got %v", err)
		}
	})

	t.Run("rejects users <= 0", func(t *testing.T) {
		raw := validRaw()
		raw["config"] = map[string]any{"users": 0, "rampUp": "5s", "duration": "30s"}
		if _, err := ParseScenario(mustMarshal(t, raw)); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("accepts thinkTime as number", func(t *testing.T) {
		raw := validRaw()
		raw["config"] = map[string]any{"users": 10, "rampUp": "5s", "duration": "30s", "thinkTime": 500}
		p, err := ParseScenario(mustMarshal(t, raw))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		tt := p.Scenario.Config.ThinkTime
		if tt == nil || tt.IsRange || tt.Fixed != 500 {
			t.Fatalf("thinkTime = %+v, want fixed 500", tt)
		}
	})

	t.Run("accepts thinkTime as {min,max}", func(t *testing.T) {
		raw := validRaw()
		raw["config"] = map[string]any{
			"users": 10, "rampUp": "5s", "duration": "30s",
			"thinkTime": map[string]any{"min": 100, "max": 300},
		}
		p, err := ParseScenario(mustMarshal(t, raw))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		tt := p.Scenario.Config.ThinkTime
		if tt == nil || !tt.IsRange || tt.Min != 100 || tt.Max != 300 {
			t.Fatalf("thinkTime = %+v, want range [100,300]", tt)
		}
	})

	t.Run("rejects thinkTime where min > max", func(t *testing.T) {
		raw := validRaw()
		raw["config"] = map[string]any{
			"users": 10, "rampUp": "5s", "duration": "30s",
			"thinkTime": map[string]any{"min": 500, "max": 100},
		}
		if _, err := ParseScenario(mustMarshal(t, raw)); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("rejects unknown HTTP methods", func(t *testing.T) {
		raw := validRaw()
		raw["scenario"] = []any{map[string]any{"name": "Bad", "method": "TRACE", "path": "/"}}
		if _, err := ParseScenario(mustMarshal(t, raw)); err == nil {
			t.Fatal("expected error")
		}
	})

	t.Run("accepts extract, onError, per-step thinkTime, and body", func(t *testing.T) {
		raw := validRaw()
		raw["scenario"] = []any{
			map[string]any{
				"name":      "Login",
				"method":    "POST",
				"path":      "/login",
				"body":      map[string]any{"user": "x"},
				"extract":   map[string]any{"token": "$.token"},
				"onError":   "abort",
				"thinkTime": map[string]any{"min": 0, "max": 50},
			},
		}
		p, err := ParseScenario(mustMarshal(t, raw))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		step := p.Scenario.Scenario[0]
		if step.OnError != "abort" {
			t.Errorf("onError = %q, want abort", step.OnError)
		}
		if step.Extract["token"] != "$.token" {
			t.Errorf("extract.token = %q, want $.token", step.Extract["token"])
		}
		// body is stored as raw JSON; compare by re-decoding.
		var body map[string]any
		if err := json.Unmarshal(step.Body, &body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if body["user"] != "x" {
			t.Errorf("body.user = %v, want x", body["user"])
		}
	})
}

func TestParseDuration(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"500ms", 500},
		{"30s", 30000},
		{"5min", 300000},
		{"1.5s", 1500},
		{"  10s  ", 10000},
		{"1MIN", 60000},
	}
	for _, c := range cases {
		got, err := parseDuration(c.in)
		if err != nil {
			t.Errorf("parseDuration(%q) error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("parseDuration(%q) = %d, want %d", c.in, got, c.want)
		}
	}
	bad := []string{"", "30", "30x", "abc", "-5s"}
	for _, b := range bad {
		if _, err := parseDuration(b); err == nil {
			t.Errorf("parseDuration(%q) = no error, want error", b)
		}
	}
}
