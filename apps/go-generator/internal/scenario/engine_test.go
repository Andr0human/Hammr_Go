package scenario

import (
	"context"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"testing"

	"github.com/Andr0human/hammr-go-generator/internal/protocol"
)

// stubDoer returns a canned response (or error) per call. Mirrors the role
// of mockAgent in apps/node/src/scenario/engine.test.ts. respFor receives
// the request — tests can assert URL/method/header/body shape.
type stubDoer struct {
	respFor func(*http.Request) (*http.Response, error)
}

func (s *stubDoer) Do(req *http.Request) (*http.Response, error) {
	return s.respFor(req)
}

func ok200(body string) *http.Response {
	return &http.Response{
		StatusCode: 200,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func status(code int, body string) *http.Response {
	return &http.Response{
		StatusCode: code,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func collect() (EventSink, *[]protocol.RawEvent) {
	var events []protocol.RawEvent
	return func(e protocol.RawEvent) { events = append(events, e) }, &events
}

func identity() VUIdentity { return VUIdentity{GeneratorID: "g1", ThreadID: 0, VUID: 1} }

func TestEngine_SingleStepSuccess(t *testing.T) {
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		return ok200(`{"ok":true}`), nil
	}}
	sink, events := collect()
	s := &Scenario{
		BaseURL:  "http://localhost:4000",
		Scenario: []ScenarioStep{{Name: "Ping", Method: "GET", Path: "/"}},
	}
	if err := RunIteration(context.Background(), s, doer, sink, identity(), nil); err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(*events) != 1 {
		t.Fatalf("want 1 event, got %d", len(*events))
	}
	got := (*events)[0]
	if got.StatusCode != 200 {
		t.Errorf("statusCode = %d", got.StatusCode)
	}
	if got.StepName != "Ping" {
		t.Errorf("stepName = %q", got.StepName)
	}
	if got.GeneratorID != "g1" || got.VUID != 1 || got.ThreadID != 0 {
		t.Errorf("identity not stamped: %+v", got)
	}
}

func TestEngine_StepFailureWithAbort(t *testing.T) {
	calls := 0
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		calls++
		return status(500, "boom"), nil
	}}
	sink, events := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "Bad", Method: "GET", Path: "/", OnError: OnErrorAbort},
			{Name: "Never", Method: "GET", Path: "/again"},
		},
	}
	_ = RunIteration(context.Background(), s, doer, sink, identity(), nil)
	if calls != 1 {
		t.Errorf("expected 1 HTTP call (abort after first), got %d", calls)
	}
	if len(*events) != 1 {
		t.Fatalf("want 1 event (abort), got %d", len(*events))
	}
	if (*events)[0].StatusCode != 500 {
		t.Errorf("statusCode = %d", (*events)[0].StatusCode)
	}
}

func TestEngine_StepFailureWithContinue(t *testing.T) {
	calls := 0
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return status(500, ""), nil
		}
		return ok200(""), nil
	}}
	sink, events := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "Bad", Method: "GET", Path: "/", OnError: OnErrorContinue},
			{Name: "Then", Method: "GET", Path: "/ok"},
		},
	}
	_ = RunIteration(context.Background(), s, doer, sink, identity(), nil)
	if len(*events) != 2 {
		t.Fatalf("want 2 events, got %d", len(*events))
	}
}

func TestEngine_ExtractFlowsToNextStep(t *testing.T) {
	calls := 0
	var second *http.Request
	doer := &stubDoer{respFor: func(req *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return ok200(`{"token":"abc123"}`), nil
		}
		second = req
		return ok200(""), nil
	}}
	sink, _ := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "Login", Method: "POST", Path: "/login", Extract: map[string]string{"token": "$.token"}},
			{Name: "Use", Method: "GET", Path: "/me", Headers: map[string]string{"Authorization": "Bearer {{token}}"}},
		},
	}
	if err := RunIteration(context.Background(), s, doer, sink, identity(), nil); err != nil {
		t.Fatalf("err: %v", err)
	}
	if second == nil {
		t.Fatal("second request not made")
	}
	if got := second.Header.Get("Authorization"); got != "Bearer abc123" {
		t.Fatalf("Authorization = %q, want Bearer abc123", got)
	}
}

func TestEngine_NetworkErrorEmitsZeroStatus(t *testing.T) {
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial tcp: connection refused")
	}}
	sink, events := collect()
	s := &Scenario{
		BaseURL:  "http://x",
		Scenario: []ScenarioStep{{Name: "Net", Method: "GET", Path: "/"}},
	}
	_ = RunIteration(context.Background(), s, doer, sink, identity(), nil)
	if len(*events) != 1 {
		t.Fatalf("want 1 event, got %d", len(*events))
	}
	if (*events)[0].StatusCode != 0 {
		t.Errorf("statusCode = %d, want 0 (engine error)", (*events)[0].StatusCode)
	}
}

func TestEngine_TeardownAbortDropsEvent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		cancel() // cancel mid-step (after the call enters); event must be dropped
		return ok200(""), nil
	}}
	sink, events := collect()
	s := &Scenario{
		BaseURL:  "http://x",
		Scenario: []ScenarioStep{{Name: "T", Method: "GET", Path: "/"}},
	}
	_ = RunIteration(ctx, s, doer, sink, identity(), nil)
	if len(*events) != 0 {
		t.Fatalf("expected 0 events on teardown abort, got %d", len(*events))
	}
}

func TestEngine_AbortBetweenSteps(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	doer := &stubDoer{respFor: func(*http.Request) (*http.Response, error) {
		calls++
		return ok200(""), nil
	}}
	sink, _ := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "First", Method: "GET", Path: "/a", OnError: OnErrorContinue},
			{Name: "Second", Method: "GET", Path: "/b"},
		},
	}
	cancel()
	_ = RunIteration(ctx, s, doer, sink, identity(), nil)
	if calls != 0 {
		t.Errorf("expected no calls after immediate cancel, got %d", calls)
	}
}

func TestEngine_ObjectBodyAddsContentType(t *testing.T) {
	var captured *http.Request
	var got string
	doer := &stubDoer{respFor: func(req *http.Request) (*http.Response, error) {
		captured = req
		b, _ := io.ReadAll(req.Body)
		got = string(b)
		return ok200(""), nil
	}}
	sink, _ := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "Post", Method: "POST", Path: "/p", Body: []byte(`{"name":"alice"}`)},
		},
	}
	_ = RunIteration(context.Background(), s, doer, sink, identity(), nil)
	if captured == nil {
		t.Fatal("no request captured")
	}
	if ct := captured.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if !strings.Contains(got, `"alice"`) {
		t.Errorf("body = %q", got)
	}
}

func TestEngine_LiteralStringBodyPreserved(t *testing.T) {
	var got string
	doer := &stubDoer{respFor: func(req *http.Request) (*http.Response, error) {
		b, _ := io.ReadAll(req.Body)
		got = string(b)
		return ok200(""), nil
	}}
	sink, _ := collect()
	s := &Scenario{
		BaseURL: "http://x",
		Scenario: []ScenarioStep{
			{Name: "Raw", Method: "POST", Path: "/p", Body: []byte(`"hello"`)},
		},
	}
	_ = RunIteration(context.Background(), s, doer, sink, identity(), nil)
	if got != "hello" {
		t.Fatalf("body = %q, want hello (string body sent verbatim)", got)
	}
}

func TestResolveThinkTime(t *testing.T) {
	if resolveThinkTime(nil, nil) != 0 {
		t.Fatal("nil → 0")
	}
	if resolveThinkTime(&ThinkTime{Fixed: 250}, nil) != 250 {
		t.Fatal("fixed")
	}
	rng := rand.New(rand.NewSource(1))
	v := resolveThinkTime(&ThinkTime{IsRange: true, Min: 100, Max: 200}, rng)
	if v < 100 || v > 200 {
		t.Fatalf("range out of [100,200]: %d", v)
	}
	// min >= max → returns min
	if got := resolveThinkTime(&ThinkTime{IsRange: true, Min: 50, Max: 50}, rng); got != 50 {
		t.Fatalf("got %d, want 50", got)
	}
}
