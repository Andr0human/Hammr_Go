package pool

import (
	"strings"
	"testing"
)

func TestVUStartDelays_EmptyWhenZeroVUs(t *testing.T) {
	got, err := VUStartDelays(0, 10_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}

func TestVUStartDelays_AllZeroWhenZeroRamp(t *testing.T) {
	got, err := VUStartDelays(5, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{0, 0, 0, 0, 0}
	if !equalInts(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
}

func TestVUStartDelays_EvenSpacing(t *testing.T) {
	got, err := VUStartDelays(10, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10 {
		t.Fatalf("len=%d", len(got))
	}
	checks := map[int]int{0: 0, 1: 100, 5: 500, 9: 900}
	for i, want := range checks {
		if got[i] != want {
			t.Errorf("delays[%d]=%d, want %d", i, got[i], want)
		}
	}
}

func TestVUStartDelays_FirstVUAtZero(t *testing.T) {
	for _, c := range []struct{ u, r int }{{1, 30_000}, {500, 60_000}} {
		got, _ := VUStartDelays(c.u, c.r)
		if got[0] != 0 {
			t.Errorf("u=%d r=%d: first delay=%d, want 0", c.u, c.r, got[0])
		}
	}
}

func TestVUStartDelays_LastVUStrictlyBeforeRamp(t *testing.T) {
	for _, c := range []struct{ u, r int }{{100, 30_000}, {500, 60_000}, {1, 1_000}} {
		got, _ := VUStartDelays(c.u, c.r)
		last := got[len(got)-1]
		if last >= c.r {
			t.Errorf("u=%d r=%d: last delay=%d, want < %d", c.u, c.r, last, c.r)
		}
	}
}

func TestVUStartDelays_MonotonicNonDecreasing(t *testing.T) {
	got, _ := VUStartDelays(137, 47_000)
	for i := 1; i < len(got); i++ {
		if got[i] < got[i-1] {
			t.Fatalf("delays[%d]=%d < delays[%d]=%d", i, got[i], i-1, got[i-1])
		}
	}
}

func TestVUStartDelays_RejectsNegativeInputs(t *testing.T) {
	if _, err := VUStartDelays(-1, 1000); err == nil {
		t.Error("want error for totalVUs=-1")
	}
	if _, err := VUStartDelays(10, -1); err == nil {
		t.Error("want error for rampUpMs=-1")
	}
}

func TestValidateCapacity_AcceptsAtCeiling(t *testing.T) {
	if err := ValidateCapacity(512, 512); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := ValidateCapacity(0, 512); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateCapacity_RejectsAboveCeiling(t *testing.T) {
	err := ValidateCapacity(1000, 512)
	if err == nil {
		t.Fatal("want error")
	}
	if !strings.Contains(err.Error(), "exceeds capacity") {
		t.Errorf("error missing 'exceeds capacity': %v", err)
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
