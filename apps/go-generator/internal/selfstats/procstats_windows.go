//go:build windows

package selfstats

import (
	"syscall"
	"unsafe"
)

// processMemoryCounters mirrors PROCESS_MEMORY_COUNTERS from <psapi.h>. We
// only read WorkingSetSize but the full struct must be passed and `cb` set to
// its byte size or the call fails.
type processMemoryCounters struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var (
	psapiDLL                 = syscall.NewLazyDLL("psapi.dll")
	procGetProcessMemoryInfo = psapiDLL.NewProc("GetProcessMemoryInfo")
)

// readRSSBytes returns the WorkingSetSize for the current process in bytes.
// This is the closest Windows equivalent to Linux VmRSS — the resident pages
// in physical RAM. Don't substitute runtime.ReadMemStats().Sys here: that's
// Go's heap accounting, not the OS resident set.
func readRSSBytes() int64 {
	h, err := syscall.GetCurrentProcess()
	if err != nil {
		return 0
	}
	var pmc processMemoryCounters
	pmc.cb = uint32(unsafe.Sizeof(pmc))
	ret, _, _ := procGetProcessMemoryInfo.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(&pmc)),
		uintptr(pmc.cb),
	)
	if ret == 0 {
		return 0
	}
	return int64(pmc.WorkingSetSize)
}

// readCPUTimes reads kernel + user CPU time via GetProcessTimes. FILETIME on
// Windows counts 100-nanosecond intervals since 1601, but for kernel/user
// times the fields are duration counters, not absolute times — multiplying by
// 100 gives the value in nanoseconds.
func readCPUTimes() cpuTimes {
	h, err := syscall.GetCurrentProcess()
	if err != nil {
		return cpuTimes{}
	}
	var creation, exit, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return cpuTimes{}
	}
	return cpuTimes{
		UserNs: filetimeToNs(user),
		SysNs:  filetimeToNs(kernel),
	}
}

func filetimeToNs(ft syscall.Filetime) int64 {
	return (int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)) * 100
}
