//go:build linux

package selfstats

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"syscall"
)

func readCPUTimes() cpuTimes {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return cpuTimes{}
	}
	return cpuTimes{
		UserNs: int64(ru.Utime.Sec)*1_000_000_000 + int64(ru.Utime.Usec)*1_000,
		SysNs:  int64(ru.Stime.Sec)*1_000_000_000 + int64(ru.Stime.Usec)*1_000,
	}
}

// readRSSBytes parses VmRSS from /proc/self/status. /proc reports VmRSS in
// kibibytes (always — even on hosts where SI conventions differ); multiply by
// 1024 to get bytes. Don't substitute runtime.ReadMemStats().Sys here: that's
// Go's accounting of memory it knows about, not the OS resident set.
func readRSSBytes() int64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "VmRSS:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, err := strconv.ParseInt(fields[1], 10, 64)
				if err != nil {
					return 0
				}
				return kb * 1024
			}
		}
	}
	return 0
}
