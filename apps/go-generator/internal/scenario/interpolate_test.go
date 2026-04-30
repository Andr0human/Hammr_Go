package scenario

import (
	"reflect"
	"testing"
)

func TestInterpolate(t *testing.T) {
	type tc struct {
		name string
		in   string
		vars map[string]any
		want string
	}
	cases := []tc{
		{"single var", "hello {{name}}", map[string]any{"name": "world"}, "hello world"},
		{"multiple vars", "{{greet}}, {{name}}!", map[string]any{"greet": "hi", "name": "ada"}, "hi, ada!"},
		{"plain string", "plain", map[string]any{}, "plain"},
		{"whitespace tolerant", "{{ name }}", map[string]any{"name": "x"}, "x"},
		{"int coerce", "id={{id}}", map[string]any{"id": 42}, "id=42"},
		{"bool coerce", "ok={{flag}}", map[string]any{"flag": true}, "ok=true"},
		{"dotted nested", "user={{user.id}}", map[string]any{"user": map[string]any{"id": 7}}, "user=7"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Interpolate(c.in, c.vars)
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}

	t.Run("missing var errors", func(t *testing.T) {
		_, err := Interpolate("hi {{nope}}", map[string]any{})
		if !IsInterpolationError(err) {
			t.Fatalf("got %v, want InterpolationError", err)
		}
	})

	t.Run("nested missing errors", func(t *testing.T) {
		_, err := Interpolate("{{user.missing}}", map[string]any{"user": map[string]any{}})
		if !IsInterpolationError(err) {
			t.Fatalf("got %v, want InterpolationError", err)
		}
	})

	t.Run("nil/missing errors", func(t *testing.T) {
		_, err := Interpolate("{{x}}", map[string]any{"x": nil})
		if !IsInterpolationError(err) {
			t.Fatalf("got %v, want InterpolationError for nil", err)
		}
		_, err = Interpolate("{{x}}", map[string]any{})
		if !IsInterpolationError(err) {
			t.Fatalf("got %v, want InterpolationError for missing key", err)
		}
	})
}

func TestInterpolateHeaders(t *testing.T) {
	t.Run("nil passthrough", func(t *testing.T) {
		out, err := InterpolateHeaders(nil, map[string]any{})
		if err != nil || out != nil {
			t.Fatalf("got (%v,%v), want (nil,nil)", out, err)
		}
	})
	t.Run("interpolates every value", func(t *testing.T) {
		out, err := InterpolateHeaders(
			map[string]string{"Authorization": "Bearer {{token}}", "X-User": "{{uid}}"},
			map[string]any{"token": "abc", "uid": 7},
		)
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := map[string]string{"Authorization": "Bearer abc", "X-User": "7"}
		if !reflect.DeepEqual(out, want) {
			t.Fatalf("got %v want %v", out, want)
		}
	})
}

func TestInterpolateBody(t *testing.T) {
	t.Run("nil passthrough", func(t *testing.T) {
		out, err := InterpolateBody(nil, map[string]any{})
		if err != nil || out != nil {
			t.Fatalf("got (%v,%v), want (nil,nil)", out, err)
		}
	})
	t.Run("string leaf", func(t *testing.T) {
		out, err := InterpolateBody("hi {{name}}", map[string]any{"name": "x"})
		if err != nil || out != "hi x" {
			t.Fatalf("got %v err=%v", out, err)
		}
	})
	t.Run("recurses into objects and arrays", func(t *testing.T) {
		input := map[string]any{
			"a": "u={{u}}",
			"b": []any{map[string]any{"c": "tok={{t}}"}, "plain"},
		}
		out, err := InterpolateBody(input, map[string]any{"u": "x", "t": "y"})
		if err != nil {
			t.Fatalf("err: %v", err)
		}
		want := map[string]any{
			"a": "u=x",
			"b": []any{map[string]any{"c": "tok=y"}, "plain"},
		}
		if !reflect.DeepEqual(out, want) {
			t.Fatalf("got %v want %v", out, want)
		}
	})
	t.Run("non-string primitives pass through", func(t *testing.T) {
		if v, _ := InterpolateBody(42, nil); v != 42 {
			t.Fatalf("int: got %v", v)
		}
		if v, _ := InterpolateBody(true, nil); v != true {
			t.Fatalf("bool: got %v", v)
		}
	})
	t.Run("does not mutate input", func(t *testing.T) {
		input := map[string]any{"a": "v={{v}}"}
		_, _ = InterpolateBody(input, map[string]any{"v": "x"})
		if input["a"] != "v={{v}}" {
			t.Fatalf("input mutated: %v", input)
		}
	})
}
