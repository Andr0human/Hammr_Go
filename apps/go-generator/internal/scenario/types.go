// Package scenario is the Go port of apps/node/src/scenario/. The wire shape
// mirrors packages/shared/src/scenario.ts; the validation rules in parse.go
// mirror packages/shared/src/parse.ts (zod). If you edit either, update both.
package scenario

import "encoding/json"

type HTTPMethod string

const (
	MethodGET    HTTPMethod = "GET"
	MethodPOST   HTTPMethod = "POST"
	MethodPUT    HTTPMethod = "PUT"
	MethodPATCH  HTTPMethod = "PATCH"
	MethodDELETE HTTPMethod = "DELETE"
)

type OnErrorPolicy string

const (
	OnErrorAbort    OnErrorPolicy = "abort"
	OnErrorContinue OnErrorPolicy = "continue"
)

// ThinkTime mirrors the TS union `number | { min, max }`. After parse, exactly
// one of the two forms is set: IsRange == false → Fixed (ms); IsRange == true
// → [Min, Max] inclusive.
type ThinkTime struct {
	IsRange bool
	Fixed   int
	Min     int
	Max     int
}

// UnmarshalJSON accepts either a number or a {min,max} object, mirroring zod.
func (t *ThinkTime) UnmarshalJSON(data []byte) error {
	// Try number first.
	var n int
	if err := json.Unmarshal(data, &n); err == nil {
		t.IsRange = false
		t.Fixed = n
		return nil
	}
	var obj struct {
		Min int `json:"min"`
		Max int `json:"max"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return err
	}
	t.IsRange = true
	t.Min = obj.Min
	t.Max = obj.Max
	return nil
}

func (t ThinkTime) MarshalJSON() ([]byte, error) {
	if t.IsRange {
		return json.Marshal(struct {
			Min int `json:"min"`
			Max int `json:"max"`
		}{t.Min, t.Max})
	}
	return json.Marshal(t.Fixed)
}

type ScenarioStep struct {
	Name      string            `json:"name"`
	Method    HTTPMethod        `json:"method"`
	Path      string            `json:"path"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      json.RawMessage   `json:"body,omitempty"`
	Extract   map[string]string `json:"extract,omitempty"`
	ThinkTime *ThinkTime        `json:"thinkTime,omitempty"`
	OnError   OnErrorPolicy     `json:"onError,omitempty"`
}

type ScenarioConfig struct {
	Users     int        `json:"users"`
	RampUp    string     `json:"rampUp"`
	Duration  string     `json:"duration"`
	ThinkTime *ThinkTime `json:"thinkTime,omitempty"`
}

type Scenario struct {
	Name     string         `json:"name"`
	BaseURL  string         `json:"baseUrl"`
	Config   ScenarioConfig `json:"config"`
	Scenario []ScenarioStep `json:"scenario"`
}

// ParsedScenario is what parseScenario returns: the validated scenario plus
// resolved durations in milliseconds.
type ParsedScenario struct {
	Scenario   Scenario
	RampUpMs   int
	DurationMs int
}
