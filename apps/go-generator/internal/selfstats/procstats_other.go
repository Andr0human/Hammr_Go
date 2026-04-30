//go:build !linux && !windows

package selfstats

// Stub for darwin and any other GOOS we haven't wired RSS/CPU readers for.
// The selftest target is Linux (Fargate); local dev runs Windows. Other
// platforms get zeros rather than a build error so `go test` still works.

func readCPUTimes() cpuTimes { return cpuTimes{} }
func readRSSBytes() int64    { return 0 }
