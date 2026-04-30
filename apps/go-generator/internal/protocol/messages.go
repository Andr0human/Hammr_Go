// Package protocol defines the WebSocket message types exchanged between the
// Go generator and the Node controller. The authoritative shape lives in
// packages/shared/src/protocol.ts; if you edit either, update the other and
// run the round-trip test in messages_test.go.
package protocol

import (
	"encoding/json"
	"fmt"
)

// RawEvent is one observation emitted per scenario step. statusCode == 0 is
// reserved for engine-level failures (network error, extract failure,
// interpolation failure, aborted iteration); see docs/gotchas.md.
//
// threadId is part of the wire shape inherited from the Node generator. The
// Go generator has no thread concept and always emits 0; the controller's
// aggregator groups by (generatorId, threadId, vuId), which (gid, 0, vuId)
// already keeps unique within a generator.
type RawEvent struct {
	StepName      string `json:"stepName"`
	StatusCode    int    `json:"statusCode"`
	LatencyMs     int    `json:"latencyMs"`
	ResponseBytes int    `json:"responseBytes"`
	Timestamp     int64  `json:"timestamp"`
	GeneratorID   string `json:"generatorId"`
	ThreadID      int    `json:"threadId"`
	VUID          int    `json:"vuId"`
}

// Generator → Controller messages. Each variant is its own struct; encode
// with json.Marshal, decode via DecodeGenMsg / DecodeCtlMsg below.

type RegisterMsg struct {
	Type        string `json:"type"` // "register"
	GeneratorID string `json:"generatorId"`
	Cores       int    `json:"cores"`
	MaxVUs      int    `json:"maxVUs"`
}

type MetricsMsg struct {
	Type          string     `json:"type"` // "metrics"
	TestID        string     `json:"testId"`
	Batch         []RawEvent `json:"batch"`
	DroppedEvents *int       `json:"droppedEvents,omitempty"`
}

type DoneStats struct {
	TotalEvents int `json:"totalEvents"`
	Errors      int `json:"errors"`
}

type DoneMsg struct {
	Type   string    `json:"type"` // "done"
	TestID string    `json:"testId"`
	Stats  DoneStats `json:"stats"`
}

type ErrorMsg struct {
	Type    string `json:"type"` // "error"
	TestID  string `json:"testId"`
	Message string `json:"message"`
}

type PongMsg struct {
	Type string `json:"type"` // "pong"
}

// Controller → Generator messages. Scenario is held as raw JSON here; the
// scenario package owns parsing/validation. Keeping it raw avoids cyclic
// imports between protocol and scenario, and means the controller can send
// scenario fields the Go side hasn't formally modelled without the message
// failing to decode.

type StartMsg struct {
	Type       string          `json:"type"` // "start"
	TestID     string          `json:"testId"`
	Scenario   json.RawMessage `json:"scenario"`
	VUs        int             `json:"vus"`
	RampUpMs   int             `json:"rampUpMs"`
	DurationMs int             `json:"durationMs"`
}

type StopMsg struct {
	Type   string `json:"type"` // "stop"
	TestID string `json:"testId"`
}

type PingMsg struct {
	Type string `json:"type"` // "ping"
}

// CtlMsg is the decoded controller-to-generator message. Exactly one of the
// pointer fields is non-nil after DecodeCtlMsg.
type CtlMsg struct {
	Start *StartMsg
	Stop  *StopMsg
	Ping  *PingMsg
}

// GenMsg is the decoded generator-to-controller message. Exactly one of the
// pointer fields is non-nil after DecodeGenMsg.
type GenMsg struct {
	Register *RegisterMsg
	Metrics  *MetricsMsg
	Done     *DoneMsg
	Error    *ErrorMsg
	Pong     *PongMsg
}

func peekType(data []byte) (string, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return "", fmt.Errorf("peek type: %w", err)
	}
	return probe.Type, nil
}

// DecodeCtlMsg parses a JSON byte slice as one of the controller-to-generator
// variants. Unknown type fields produce an error rather than a silent drop so
// protocol drift surfaces immediately.
func DecodeCtlMsg(data []byte) (CtlMsg, error) {
	t, err := peekType(data)
	if err != nil {
		return CtlMsg{}, err
	}
	switch t {
	case "start":
		var m StartMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return CtlMsg{}, fmt.Errorf("decode start: %w", err)
		}
		return CtlMsg{Start: &m}, nil
	case "stop":
		var m StopMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return CtlMsg{}, fmt.Errorf("decode stop: %w", err)
		}
		return CtlMsg{Stop: &m}, nil
	case "ping":
		var m PingMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return CtlMsg{}, fmt.Errorf("decode ping: %w", err)
		}
		return CtlMsg{Ping: &m}, nil
	default:
		return CtlMsg{}, fmt.Errorf("unknown CtlMsg type: %q", t)
	}
}

// DecodeGenMsg parses a JSON byte slice as one of the generator-to-controller
// variants. Used in tests (and any tooling that round-trips fixtures).
func DecodeGenMsg(data []byte) (GenMsg, error) {
	t, err := peekType(data)
	if err != nil {
		return GenMsg{}, err
	}
	switch t {
	case "register":
		var m RegisterMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return GenMsg{}, fmt.Errorf("decode register: %w", err)
		}
		return GenMsg{Register: &m}, nil
	case "metrics":
		var m MetricsMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return GenMsg{}, fmt.Errorf("decode metrics: %w", err)
		}
		return GenMsg{Metrics: &m}, nil
	case "done":
		var m DoneMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return GenMsg{}, fmt.Errorf("decode done: %w", err)
		}
		return GenMsg{Done: &m}, nil
	case "error":
		var m ErrorMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return GenMsg{}, fmt.Errorf("decode error: %w", err)
		}
		return GenMsg{Error: &m}, nil
	case "pong":
		var m PongMsg
		if err := json.Unmarshal(data, &m); err != nil {
			return GenMsg{}, fmt.Errorf("decode pong: %w", err)
		}
		return GenMsg{Pong: &m}, nil
	default:
		return GenMsg{}, fmt.Errorf("unknown GenMsg type: %q", t)
	}
}
