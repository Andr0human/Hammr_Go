'use client';
import { useEffect, useRef, useState } from 'react';
import type { PerSecondMetric } from '@hammr/shared';
import { getSocket } from '../lib/socket';

export interface SettledPayload {
  testId: string;
  state: string;
  endReason: 'completed' | 'failed' | 'aborted';
  totalEvents: number;
  errors: number;
  droppedEvents: number;
  durationMs: number;
  error?: string;
}

export interface LiveTestState {
  // Per-second metrics received from the controller for THIS testId.
  // Append-only. The aggregator emits buckets ~2s after wall-clock thanks to
  // its watermark, so even a fresh subscription catches up within a second.
  metrics: PerSecondMetric[];
  // True from the moment the controller emits test:started for testId, or
  // immediately if we joined while the test was already running. We don't
  // know "already running" until the first test:metrics arrives — until then
  // we render the empty live view, which matches reality.
  liveActive: boolean;
  settled: SettledPayload | null;
  connected: boolean;
}

// Subscribes to the browser-ws stream and accumulates metrics for a single
// testId. Discards events for other test ids (defensive: V1 only ever runs
// one test at a time, but the broadcast is to all connected clients).
//
// Watermark: the aggregator closes second-buckets ~2s late so generators have
// time to land their batches over the WS hop. The rolling-window cap (5 min
// × N steps) keeps the in-memory buffer bounded for very long tests; the
// historical view (cold path) is the source of truth for full-test data.
const ROLLING_WINDOW_SECS = 300;

export function useLiveTest(testId: string): LiveTestState {
  const [state, setState] = useState<LiveTestState>({
    metrics: [],
    liveActive: false,
    settled: null,
    connected: false,
  });
  const seenSeconds = useRef<Set<string>>(new Set());

  useEffect(() => {
    seenSeconds.current = new Set();
    setState({ metrics: [], liveActive: false, settled: null, connected: false });

    const socket = getSocket();

    const onConnect = () => setState((s) => ({ ...s, connected: true }));
    const onDisconnect = () => setState((s) => ({ ...s, connected: false }));

    const onStarted = (ev: { testId: string }) => {
      if (ev.testId !== testId) return;
      setState((s) => ({ ...s, liveActive: true, settled: null }));
    };

    const onMetrics = (ev: { testId: string; metrics: PerSecondMetric[] }) => {
      if (ev.testId !== testId) return;
      // De-dupe OUTSIDE the setState updater — React 18 StrictMode double-
      // invokes updaters in dev to catch impurity, and mutating a ref inside
      // would make the second invocation skip every "new" metric and return
      // an unchanged array. Updater must stay pure.
      const fresh: PerSecondMetric[] = [];
      for (const m of ev.metrics) {
        const key = `${m.second}:${m.stepName}`;
        if (seenSeconds.current.has(key)) continue;
        seenSeconds.current.add(key);
        fresh.push(m);
      }
      setState((prev) => {
        if (fresh.length === 0) {
          return prev.liveActive ? prev : { ...prev, liveActive: true };
        }
        const next = prev.metrics.concat(fresh);
        // Trim the rolling window. Counted in seconds (not rows) so multi-step
        // scenarios don't get prematurely truncated.
        const cutoff = next[next.length - 1]!.second - ROLLING_WINDOW_SECS;
        while (next.length > 0 && next[0]!.second < cutoff) next.shift();
        return { ...prev, liveActive: true, metrics: next };
      });
    };

    const onSettled = (ev: { testId: string; result: SettledPayload }) => {
      if (ev.testId !== testId) return;
      setState((s) => ({ ...s, liveActive: false, settled: ev.result }));
    };

    if (socket.connected) onConnect();
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('test:started', onStarted);
    socket.on('test:metrics', onMetrics);
    socket.on('test:settled', onSettled);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('test:started', onStarted);
      socket.off('test:metrics', onMetrics);
      socket.off('test:settled', onSettled);
    };
  }, [testId]);

  return state;
}
