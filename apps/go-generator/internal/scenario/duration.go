package scenario

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// durationRE mirrors the regex in packages/shared/src/duration.ts.
// Anchored, case-insensitive, allows optional fractional values.
var durationRE = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)$`)

// parseDuration ports packages/shared/src/duration.ts. Output is milliseconds
// rounded to the nearest integer (TS uses Math.round; we match its half-away
// behaviour for non-negative inputs by adding 0.5 before truncation).
func parseDuration(input string) (int, error) {
	s := strings.TrimSpace(input)
	m := durationRE.FindStringSubmatch(strings.ToLower(s))
	if m == nil {
		return 0, fmt.Errorf(`Invalid duration: %s (expected e.g. "30s", "5min", "500ms")`, input)
	}
	value, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, fmt.Errorf("invalid duration number %q: %w", m[1], err)
	}
	switch m[2] {
	case "ms":
		return roundHalfAwayFromZero(value), nil
	case "s", "sec", "secs":
		return roundHalfAwayFromZero(value * 1000), nil
	case "m", "min", "mins":
		return roundHalfAwayFromZero(value * 60000), nil
	default:
		return 0, fmt.Errorf("Unknown duration unit: %s", m[2])
	}
}

func roundHalfAwayFromZero(v float64) int {
	if v >= 0 {
		return int(math.Floor(v + 0.5))
	}
	return int(math.Ceil(v - 0.5))
}
