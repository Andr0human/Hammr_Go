package scenario

import (
	"encoding/json"
	"testing"
)

// decode reproduces a real engine input: an HTTP response body parsed with
// encoding/json into interface{}. Numbers come back as float64 — the test
// expectations account for that.
func decode(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

func TestExtractPath(t *testing.T) {
	t.Run("top-level $.name", func(t *testing.T) {
		v, err := ExtractPath(decode(t, `{"token":"abc"}`), "$.token")
		if err != nil || v != "abc" {
			t.Fatalf("got (%v,%v)", v, err)
		}
	})

	t.Run("nested $.user.id", func(t *testing.T) {
		v, err := ExtractPath(decode(t, `{"user":{"id":42}}`), "$.user.id")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if f, ok := v.(float64); !ok || f != 42 {
			t.Fatalf("got %v (%T)", v, v)
		}
	})

	t.Run("array index $.items[0].id", func(t *testing.T) {
		v, err := ExtractPath(decode(t, `{"items":[{"id":1},{"id":2}]}`), "$.items[0].id")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if f, ok := v.(float64); !ok || f != 1 {
			t.Fatalf("got %v (%T)", v, v)
		}
	})

	t.Run("wildcard $.items[*].id returns first", func(t *testing.T) {
		v, err := ExtractPath(decode(t, `{"items":[{"id":1},{"id":2}]}`), "$.items[*].id")
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		if f, ok := v.(float64); !ok || f != 1 {
			t.Fatalf("got %v (%T)", v, v)
		}
	})

	t.Run("missing path errors", func(t *testing.T) {
		_, err := ExtractPath(decode(t, `{"a":1}`), "$.missing")
		if !IsExtractError(err) {
			t.Fatalf("got %v, want ExtractError", err)
		}
	})

	t.Run("nil input errors", func(t *testing.T) {
		_, err := ExtractPath(nil, "$.x")
		if !IsExtractError(err) {
			t.Fatalf("got %v, want ExtractError", err)
		}
	})
}
