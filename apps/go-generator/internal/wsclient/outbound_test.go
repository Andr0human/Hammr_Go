package wsclient

import (
	"testing"

	"github.com/Andr0human/hammr-go-generator/internal/protocol"
)

// Drop-newest plus drop-counter restoration is the load-bearing invariant of
// outbound: when the channel is full, the rejected batch's events PLUS any
// dropped-events the batcher had attached must roll back into pendingDropped
// so neither count is silently lost. This test pins that down without spinning
// up a real connection.
func TestOutboundDropNewestRestoresCounters(t *testing.T) {
	o := newOutbound(1)

	// First batch fills the channel.
	first := &protocol.MetricsMsg{
		Type:  "metrics",
		Batch: []protocol.RawEvent{{}, {}, {}},
	}
	if !o.trySendMetrics(first) {
		t.Fatal("first send should succeed into a 1-slot channel")
	}

	// Second batch should be rejected; both its event count AND the carried
	// dropped-events count must accumulate in pendingDropped so we don't lose
	// the running tally.
	five := 5
	second := &protocol.MetricsMsg{
		Type:          "metrics",
		Batch:         []protocol.RawEvent{{}, {}}, // 2 events
		DroppedEvents: &five,                       // batcher had 5 drops queued
	}
	if o.trySendMetrics(second) {
		t.Fatal("second send should be rejected by the full channel")
	}
	if got, want := o.takeDropped(), 7; got != want {
		t.Fatalf("pendingDropped: want %d (2 batch + 5 carried), got %d", want, got)
	}
	// takeDropped is destructive; a follow-up read should be 0.
	if got := o.takeDropped(); got != 0 {
		t.Fatalf("takeDropped should reset; got %d on second call", got)
	}
}

func TestOutboundSendBlockingHonoursCancel(t *testing.T) {
	o := newOutbound(1)
	// Fill the slot.
	if !o.trySendMetrics(&protocol.MetricsMsg{Type: "metrics"}) {
		t.Fatal("first send should succeed")
	}
	// sendBlocking on a full channel must respect the cancel signal rather
	// than deadlock. This matters for shutdown — the wsclient sends `done`
	// via sendBlocking, and a wedged writer must not pin shutdown.
	cancel := make(chan struct{})
	close(cancel)
	if o.sendBlocking(outboundMsg{Pong: &protocol.PongMsg{Type: "pong"}}, cancel) {
		t.Fatal("sendBlocking should have returned false on already-closed cancel")
	}
}
