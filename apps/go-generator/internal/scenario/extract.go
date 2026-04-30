package scenario

import (
	"errors"
	"fmt"
	"strings"

	"github.com/PaesslerAG/jsonpath"
)

// ExtractError is returned when a JSONPath expression yields no match or the
// input was not a JSON-decoded value. Mirrors apps/node/src/scenario/extract.ts.
type ExtractError struct {
	Path   string
	Reason string
}

func (e *ExtractError) Error() string {
	return fmt.Sprintf(`extract %q failed: %s`, e.Path, e.Reason)
}

// IsExtractError reports whether err wraps an ExtractError.
func IsExtractError(err error) bool {
	var e *ExtractError
	return errors.As(err, &e)
}

// ExtractPath applies a JSONPath expression to a JSON-decoded value (the kind
// of tree json.Unmarshal produces into interface{}: maps, slices, scalars)
// and returns the first match. Mirrors jsonpath-plus({wrap:true})[0] in TS.
//
// `pathContainsMulti` cases ($.items[*]..., $..foo) yield a slice from the
// PaesslerAG library; we take the first element. Single-match paths return
// the value directly.
func ExtractPath(json any, path string) (any, error) {
	if json == nil {
		return nil, &ExtractError{Path: path, Reason: "response body was not JSON"}
	}
	result, err := jsonpath.Get(path, json)
	if err != nil {
		return nil, &ExtractError{Path: path, Reason: "no match"}
	}
	if pathContainsMulti(path) {
		slice, ok := result.([]any)
		if !ok {
			// Library returned a scalar despite a wildcard path — treat as match.
			return result, nil
		}
		if len(slice) == 0 {
			return nil, &ExtractError{Path: path, Reason: "no match"}
		}
		return slice[0], nil
	}
	return result, nil
}

// pathContainsMulti reports whether the path uses a wildcard or recursive
// descent. Used only to decide whether to unwrap the [first match] from a
// slice the library returns for those forms. Conservative — false negatives
// are fine (we just don't unwrap), false positives would unwrap a literal
// scalar slice, which doesn't occur with our scenarios.
func pathContainsMulti(p string) bool {
	return strings.Contains(p, "[*]") || strings.Contains(p, "..")
}
