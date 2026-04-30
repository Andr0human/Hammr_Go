package scenario

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// {{var}} interpolation applied to string values in path, headers, and body.
// Variable names may contain letters, digits, underscores, and dots. A
// reference to a missing variable returns an InterpolationError so the
// engine can treat it as a step failure and apply the onError policy.
//
// The regex deliberately matches the TS one in apps/node/src/scenario/
// interpolate.ts: `\{\{\s*([\w.]+)\s*\}\}`.
var varRE = regexp.MustCompile(`\{\{\s*([\w.]+)\s*\}\}`)

// InterpolationError is returned when a referenced variable is missing or has
// a nil value. Engine code checks via errors.As.
type InterpolationError struct {
	Variable string
}

func (e *InterpolationError) Error() string {
	return fmt.Sprintf(`Missing variable "%s" in interpolation`, e.Variable)
}

// IsInterpolationError reports whether err wraps an InterpolationError.
func IsInterpolationError(err error) bool {
	var e *InterpolationError
	return errors.As(err, &e)
}

// Interpolate replaces every {{var}} (with optional whitespace) with the
// resolved variable value, coerced to its Go fmt %v form. Missing variables
// yield an InterpolationError on first miss.
func Interpolate(s string, vars map[string]any) (string, error) {
	var firstErr error
	out := varRE.ReplaceAllStringFunc(s, func(match string) string {
		if firstErr != nil {
			return match
		}
		sub := varRE.FindStringSubmatch(match)
		name := sub[1]
		val, ok := resolve(vars, name)
		if !ok || val == nil {
			firstErr = &InterpolationError{Variable: name}
			return match
		}
		return formatValue(val)
	})
	if firstErr != nil {
		return "", firstErr
	}
	return out, nil
}

// InterpolateHeaders interpolates every header value. Returns nil for nil input.
func InterpolateHeaders(headers map[string]string, vars map[string]any) (map[string]string, error) {
	if headers == nil {
		return nil, nil
	}
	out := make(map[string]string, len(headers))
	for k, v := range headers {
		s, err := Interpolate(v, vars)
		if err != nil {
			return nil, err
		}
		out[k] = s
	}
	return out, nil
}

// InterpolateBody walks a body value (decoded JSON: maps, slices, scalars)
// and interpolates every string leaf. Maps and slices are cloned so the
// caller's input is not mutated. Non-string primitives pass through.
func InterpolateBody(body any, vars map[string]any) (any, error) {
	switch v := body.(type) {
	case nil:
		return nil, nil
	case string:
		return Interpolate(v, vars)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			r, err := InterpolateBody(item, vars)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			r, err := InterpolateBody(item, vars)
			if err != nil {
				return nil, err
			}
			out[k] = r
		}
		return out, nil
	default:
		return v, nil
	}
}

// resolve walks dotted paths through nested map[string]any. Returns
// (value, found). A nil value with found == true is still treated as a
// missing variable by the caller, mirroring the TS behaviour where null
// or undefined both throw.
func resolve(vars map[string]any, name string) (any, bool) {
	if !strings.Contains(name, ".") {
		v, ok := vars[name]
		return v, ok
	}
	var current any = vars
	for _, part := range strings.Split(name, ".") {
		m, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[part]
		if !ok {
			return nil, false
		}
		current = v
	}
	return current, true
}

// formatValue mirrors TS's String(value): numbers use the shortest decimal
// form, booleans render as "true"/"false". For ints we want "42", not "42.0";
// for floats we want minimal precision. Go's default %v handles bool and
// integer types correctly; for float64 (which JSON numbers decode to) we
// strip trailing ".0" when the value is integer-valued.
func formatValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", x), "0"), ".")
	case int:
		return fmt.Sprintf("%d", x)
	case int64:
		return fmt.Sprintf("%d", x)
	default:
		return fmt.Sprintf("%v", x)
	}
}
