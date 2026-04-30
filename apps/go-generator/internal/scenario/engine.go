package scenario

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/Andr0human/hammr-go-generator/internal/protocol"
)

// HTTPDoer is the minimum http.Client surface the engine needs. Tests inject
// a stub; production wires *http.Client. Mirrors undici.Dispatcher's role on
// the Node side without coupling the engine to a particular client impl.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// EventSink is called once per scenario step (regardless of success), unless
// the run-level context was cancelled mid-step (teardown abort — see
// docs/gotchas.md "Teardown aborts produce a fake 100%-error tail").
type EventSink func(protocol.RawEvent)

// VUIdentity stamps RawEvent fields. ThreadID is always 0 from Go (see
// docs/spec/go-generator.md "Wire compatibility").
type VUIdentity struct {
	GeneratorID string
	ThreadID    int
	VUID        int
}

// Now / Sleep are package-level vars so engine tests can stub time without
// dragging a clock interface through every call.
var (
	nowMs = func() int64 { return time.Now().UnixMilli() }
	since = func(start time.Time) time.Duration { return time.Since(start) }
)

// RunIteration runs one full pass through scenario.Scenario, emitting one
// RawEvent per step. The configured onError policy decides whether a failed
// step aborts the iteration. Mirrors apps/node/src/scenario/engine.ts
// runIteration.
func RunIteration(
	ctx context.Context,
	s *Scenario,
	doer HTTPDoer,
	sink EventSink,
	identity VUIdentity,
	rng *rand.Rand,
) error {
	vars := make(map[string]any)
	for i := range s.Scenario {
		if ctx.Err() != nil {
			return nil
		}
		step := &s.Scenario[i]
		failed := runStep(ctx, step, s.BaseURL, vars, doer, sink, identity)

		onError := step.OnError
		if onError == "" {
			onError = OnErrorAbort
		}
		if failed && onError == OnErrorAbort {
			return nil
		}

		var thinkSrc *ThinkTime
		if step.ThinkTime != nil {
			thinkSrc = step.ThinkTime
		} else {
			thinkSrc = s.Config.ThinkTime
		}
		thinkMs := resolveThinkTime(thinkSrc, rng)
		if thinkMs > 0 && ctx.Err() == nil {
			sleepCtx(ctx, time.Duration(thinkMs)*time.Millisecond)
		}
	}
	return nil
}

func runStep(
	ctx context.Context,
	step *ScenarioStep,
	baseURL string,
	vars map[string]any,
	doer HTTPDoer,
	sink EventSink,
	identity VUIdentity,
) bool {
	t0 := time.Now()
	statusCode := 0
	responseBytes := 0
	failed := false

	stepErr := func() error {
		path, err := Interpolate(step.Path, vars)
		if err != nil {
			return err
		}
		url := joinURL(baseURL, path)

		headers, err := InterpolateHeaders(step.Headers, vars)
		if err != nil {
			return err
		}

		var bodyReader io.Reader
		if len(step.Body) > 0 {
			// step.Body is raw JSON bytes from the scenario. Decode → interpolate
			// string leaves → re-encode.
			var raw any
			if err := json.Unmarshal(step.Body, &raw); err != nil {
				return err
			}
			interp, err := InterpolateBody(raw, vars)
			if err != nil {
				return err
			}
			switch v := interp.(type) {
			case string:
				bodyReader = strings.NewReader(v)
			default:
				out, err := json.Marshal(v)
				if err != nil {
					return err
				}
				bodyReader = bytes.NewReader(out)
				if !hasHeader(headers, "content-type") {
					if headers == nil {
						headers = make(map[string]string)
					}
					headers["Content-Type"] = "application/json"
				}
			}
		}

		req, err := http.NewRequestWithContext(ctx, string(step.Method), url, bodyReader)
		if err != nil {
			return err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}

		res, err := doer.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		statusCode = res.StatusCode

		bodyBytes, err := io.ReadAll(res.Body)
		if err != nil {
			return err
		}
		responseBytes = len(bodyBytes)

		if statusCode >= 400 {
			failed = true
			return nil
		}
		if step.Extract != nil {
			var parsed any
			if err := json.Unmarshal(bodyBytes, &parsed); err != nil {
				failed = true
				return nil
			}
			for k, expr := range step.Extract {
				val, err := ExtractPath(parsed, expr)
				if err != nil {
					failed = true
					return nil
				}
				vars[k] = val
			}
		}
		return nil
	}()

	if stepErr != nil {
		// Network error, interpolation error, request build error: statusCode
		// stays 0 (engine-error sentinel — see docs/gotchas.md).
		failed = true
	}

	// Drop teardown aborts. While the only ctx is the run-level one, a
	// cancelled context after the request means the run is shutting down —
	// don't pollute the trailing bucket with a fake 100%-error tail. Same
	// caveat as engine.ts: if per-request timeouts are added later, narrow
	// this check to run-level cancellation specifically.
	if ctx.Err() != nil {
		return failed
	}

	latencyMs := int(since(t0) / time.Millisecond)
	if latencyMs < 0 {
		latencyMs = 0
	}
	sink(protocol.RawEvent{
		StepName:      step.Name,
		StatusCode:    statusCode,
		LatencyMs:     latencyMs,
		ResponseBytes: responseBytes,
		Timestamp:     nowMs(),
		GeneratorID:   identity.GeneratorID,
		ThreadID:      identity.ThreadID,
		VUID:          identity.VUID,
	})
	return failed
}

// resolveThinkTime mirrors engine.ts resolveThinkTime: number → fixed,
// {min,max} → uniform pick in [min,max], min>=max → min.
func resolveThinkTime(tt *ThinkTime, rng *rand.Rand) int {
	if tt == nil {
		return 0
	}
	if !tt.IsRange {
		return tt.Fixed
	}
	if tt.Min >= tt.Max {
		return tt.Min
	}
	if rng == nil {
		return tt.Min
	}
	return tt.Min + rng.Intn(tt.Max-tt.Min+1)
}

func joinURL(base, path string) string {
	if strings.HasPrefix(strings.ToLower(path), "http://") ||
		strings.HasPrefix(strings.ToLower(path), "https://") {
		return path
	}
	b := strings.TrimSuffix(base, "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return b + path
}

func hasHeader(headers map[string]string, name string) bool {
	lower := strings.ToLower(name)
	for k := range headers {
		if strings.ToLower(k) == lower {
			return true
		}
	}
	return false
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

