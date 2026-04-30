package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// roundTripJSON normalises two JSON byte slices to interface{} trees and
// compares with reflect.DeepEqual. Compares value identity, not byte order
// or whitespace — Go's json.Marshal sorts map keys, so a textual byte-equal
// would fail spuriously on every multi-field message.
func roundTripJSON(t *testing.T, original, marshalled []byte) {
	t.Helper()
	var a, b interface{}
	if err := json.Unmarshal(original, &a); err != nil {
		t.Fatalf("unmarshal original: %v", err)
	}
	if err := json.Unmarshal(marshalled, &b); err != nil {
		t.Fatalf("unmarshal marshalled: %v", err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("round-trip drift\n original:   %s\n marshalled: %s", original, marshalled)
	}
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return data
}

func TestGenMsgRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		fixture string
		variant func(*GenMsg) any // pull the non-nil pointer out for re-marshal
	}{
		{"register", "register.json", func(m *GenMsg) any { return m.Register }},
		{"metrics_with_drops", "metrics.json", func(m *GenMsg) any { return m.Metrics }},
		{"metrics_no_drops", "metrics_no_drops.json", func(m *GenMsg) any { return m.Metrics }},
		{"done", "done.json", func(m *GenMsg) any { return m.Done }},
		{"error", "error.json", func(m *GenMsg) any { return m.Error }},
		{"pong", "pong.json", func(m *GenMsg) any { return m.Pong }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := readFixture(t, tc.fixture)
			msg, err := DecodeGenMsg(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			variant := tc.variant(&msg)
			if variant == nil || reflect.ValueOf(variant).IsNil() {
				t.Fatalf("expected variant non-nil for %s", tc.name)
			}
			out, err := json.Marshal(variant)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			roundTripJSON(t, raw, out)
		})
	}
}

func TestCtlMsgRoundTrip(t *testing.T) {
	cases := []struct {
		name    string
		fixture string
		variant func(*CtlMsg) any
	}{
		{"start", "start.json", func(m *CtlMsg) any { return m.Start }},
		{"stop", "stop.json", func(m *CtlMsg) any { return m.Stop }},
		{"ping", "ping.json", func(m *CtlMsg) any { return m.Ping }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := readFixture(t, tc.fixture)
			msg, err := DecodeCtlMsg(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			variant := tc.variant(&msg)
			if variant == nil || reflect.ValueOf(variant).IsNil() {
				t.Fatalf("expected variant non-nil for %s", tc.name)
			}
			out, err := json.Marshal(variant)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			roundTripJSON(t, raw, out)
		})
	}
}

func TestDecodeUnknownType(t *testing.T) {
	if _, err := DecodeGenMsg([]byte(`{"type":"frobnicate"}`)); err == nil {
		t.Fatal("expected error for unknown GenMsg type")
	}
	if _, err := DecodeCtlMsg([]byte(`{"type":"frobnicate"}`)); err == nil {
		t.Fatal("expected error for unknown CtlMsg type")
	}
}

func TestRawEventStatusCodeZeroIsValid(t *testing.T) {
	// status_code=0 is the engine-error sentinel; ensure it round-trips
	// without omitempty stripping it (the field has no omitempty).
	ev := RawEvent{StepName: "x", StatusCode: 0, Timestamp: 1, GeneratorID: "g", VUID: 1}
	out, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back RawEvent
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.StatusCode != 0 {
		t.Fatalf("statusCode dropped on round-trip: %s", out)
	}
}
