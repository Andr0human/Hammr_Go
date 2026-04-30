package scenario

import (
	"encoding/json"
	"fmt"
	"strings"
)

// validMethods mirrors the zod enum in packages/shared/src/parse.ts.
var validMethods = map[HTTPMethod]struct{}{
	MethodGET: {}, MethodPOST: {}, MethodPUT: {}, MethodPATCH: {}, MethodDELETE: {},
}

var validOnError = map[OnErrorPolicy]struct{}{
	OnErrorAbort: {}, OnErrorContinue: {},
}

// ParseScenario validates a raw JSON scenario (as bytes) and returns the
// parsed form with resolved durations. Equivalent to packages/shared/src/
// parse.ts's parseScenario.
func ParseScenario(raw []byte) (ParsedScenario, error) {
	var s Scenario
	if err := json.Unmarshal(raw, &s); err != nil {
		return ParsedScenario{}, fmt.Errorf("scenario JSON: %w", err)
	}
	if err := validateScenario(&s); err != nil {
		return ParsedScenario{}, err
	}
	rampUpMs, err := parseDuration(s.Config.RampUp)
	if err != nil {
		return ParsedScenario{}, err
	}
	durationMs, err := parseDuration(s.Config.Duration)
	if err != nil {
		return ParsedScenario{}, err
	}
	if durationMs <= rampUpMs {
		return ParsedScenario{}, fmt.Errorf(
			"duration (%s) must be greater than rampUp (%s)",
			s.Config.Duration, s.Config.RampUp,
		)
	}
	return ParsedScenario{Scenario: s, RampUpMs: rampUpMs, DurationMs: durationMs}, nil
}

// ParseScenarioValue is a convenience wrapper that takes an already-decoded
// value (e.g. an interface{} from a wider JSON structure) and re-encodes it
// before validation. Mirrors parseScenario(raw: unknown) in TS.
func ParseScenarioValue(v any) (ParsedScenario, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return ParsedScenario{}, fmt.Errorf("re-encode scenario: %w", err)
	}
	return ParseScenario(raw)
}

func validateScenario(s *Scenario) error {
	if s.Name == "" {
		return fmt.Errorf("name must be non-empty")
	}
	if !strings.HasPrefix(strings.ToLower(s.BaseURL), "http://") &&
		!strings.HasPrefix(strings.ToLower(s.BaseURL), "https://") {
		return fmt.Errorf("baseUrl must start with http:// or https://")
	}
	if err := validateConfig(&s.Config); err != nil {
		return err
	}
	if len(s.Scenario) == 0 {
		return fmt.Errorf("scenario must have at least one step")
	}
	names := make(map[string]struct{}, len(s.Scenario))
	for i := range s.Scenario {
		step := &s.Scenario[i]
		if err := validateStep(step); err != nil {
			return err
		}
		if _, dup := names[step.Name]; dup {
			return fmt.Errorf("duplicate step name: %s", step.Name)
		}
		names[step.Name] = struct{}{}
	}
	return nil
}

func validateConfig(c *ScenarioConfig) error {
	if c.Users <= 0 {
		return fmt.Errorf("users must be a positive integer")
	}
	if c.RampUp == "" {
		return fmt.Errorf("rampUp must be non-empty")
	}
	if c.Duration == "" {
		return fmt.Errorf("duration must be non-empty")
	}
	if c.ThinkTime != nil {
		if err := validateThinkTime(c.ThinkTime); err != nil {
			return err
		}
	}
	return nil
}

func validateStep(s *ScenarioStep) error {
	if s.Name == "" {
		return fmt.Errorf("step name must be non-empty")
	}
	if _, ok := validMethods[s.Method]; !ok {
		return fmt.Errorf("invalid method %q (allowed: GET, POST, PUT, PATCH, DELETE)", s.Method)
	}
	if s.Path == "" {
		return fmt.Errorf("step path must be non-empty")
	}
	for k, v := range s.Headers {
		if k == "" || v == "" {
			return fmt.Errorf("step %q: header keys and values must be non-empty", s.Name)
		}
	}
	for k, v := range s.Extract {
		if k == "" || v == "" {
			return fmt.Errorf("step %q: extract keys and values must be non-empty", s.Name)
		}
	}
	if s.OnError != "" {
		if _, ok := validOnError[s.OnError]; !ok {
			return fmt.Errorf("step %q: invalid onError %q", s.Name, s.OnError)
		}
	}
	if s.ThinkTime != nil {
		if err := validateThinkTime(s.ThinkTime); err != nil {
			return fmt.Errorf("step %q: %w", s.Name, err)
		}
	}
	return nil
}

func validateThinkTime(t *ThinkTime) error {
	if t.IsRange {
		if t.Min < 0 || t.Max < 0 {
			return fmt.Errorf("thinkTime min/max must be non-negative")
		}
		if t.Min > t.Max {
			return fmt.Errorf("thinkTime.min must be <= thinkTime.max")
		}
		return nil
	}
	if t.Fixed < 0 {
		return fmt.Errorf("thinkTime must be non-negative")
	}
	return nil
}
