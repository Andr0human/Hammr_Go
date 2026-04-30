// Package httpclient builds the one shared *http.Client every VU goroutine
// uses. Tuning mirrors the Node generator's undici Pool (see
// apps/node/src/generator/agent.ts):
//
//   - keep-alive on, idle timeout 60s
//   - MaxIdleConnsPerHost = maxVUs so we don't churn TCP per iteration
//   - no per-request timeout — request lifetime is bounded by the run-level
//     context.Context. See docs/gotchas.md "Teardown aborts produce a fake
//     100%-error tail" for why a per-request timeout would change the
//     engine's abort semantics.
package httpclient

import (
	"net"
	"net/http"
	"time"
)

// New returns an *http.Client tuned for sustained N-VU load. maxVUs sizes the
// idle-conn pool; pass the generator's MAX_VUS, not the test's `users`.
func New(maxVUs int) *http.Client {
	if maxVUs < 1 {
		maxVUs = 1
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          maxVUs * 2,
		MaxIdleConnsPerHost:   maxVUs,
		MaxConnsPerHost:       0, // unbounded; rely on goroutine count to cap
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		DisableKeepAlives:     false,
	}
	return &http.Client{
		Transport: transport,
		// No Timeout: request cancellation is driven by the run-level context.
		// Adding one here would mean teardown filtering in the engine could
		// not distinguish run-abort from per-request timeout.
	}
}
