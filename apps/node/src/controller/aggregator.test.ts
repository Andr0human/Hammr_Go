import test from 'node:test';
import assert from 'node:assert/strict';
import type { RawEvent } from '@hammr/shared';
import { Aggregator } from './aggregator.js';

function ev(over: Partial<RawEvent>): RawEvent {
  return {
    stepName: 'Login',
    statusCode: 200,
    latencyMs: 10,
    responseBytes: 100,
    timestamp: 1_000_000_000,
    generatorId: 'g1',
    threadId: 0,
    vuId: 0,
    ...over,
  };
}

test('groups events into per-second + per-step buckets', () => {
  const a = new Aggregator();
  a.addBatch([
    ev({ timestamp: 1_000_000_000, stepName: 'A', latencyMs: 1 }),
    ev({ timestamp: 1_000_000_500, stepName: 'A', latencyMs: 3 }),
    ev({ timestamp: 1_000_000_999, stepName: 'B', latencyMs: 5 }),
    ev({ timestamp: 1_000_001_000, stepName: 'A', latencyMs: 7 }),
  ]);
  // Aggregator holds 3 distinct buckets: (A, 1_000_000), (B, 1_000_000), (A, 1_000_001)
  assert.equal(a.size(), 3);
});

test('flushClosed only emits buckets older than watermark', () => {
  const a = new Aggregator({ watermarkSeconds: 2 });
  a.addBatch([
    ev({ timestamp: 1_000_000_000, latencyMs: 1 }),
    ev({ timestamp: 1_000_001_000, latencyMs: 2 }),
    ev({ timestamp: 1_000_002_000, latencyMs: 3 }), // current second; not flushed
  ]);
  // 'now' = 1_000_002_500ms => current sec = 1_000_002; cutoff = sec - 2 = 1_000_000
  // So sec <= 1_000_000 flushes (only the first one).
  const closed = a.flushClosed(1_000_002_500);
  assert.equal(closed.length, 1);
  assert.equal(closed[0]?.second, 1_000_000);
  assert.equal(a.size(), 2);
});

test('per-bucket metrics: rps, error rate, percentiles, bytes', () => {
  const a = new Aggregator();
  // 10 events in second 1_000_000, step Login: 8 OK, 2 errors.
  // Nearest-rank on sorted [1..10]: idx=floor(9*p)
  //   p50 -> idx 4 -> 5
  //   p95 -> idx 8 -> 9
  //   p99 -> idx 8 -> 9
  // Bytes: 10 * 100 = 1000.
  const batch: RawEvent[] = [];
  for (let i = 1; i <= 10; i++) {
    batch.push(
      ev({
        timestamp: 1_000_000_000 + i, // all land in second 1_000_000
        latencyMs: i,
        statusCode: i <= 8 ? 200 : 500,
      }),
    );
  }
  a.addBatch(batch);
  const out = a.drainAll();
  assert.equal(out.length, 1);
  const m = out[0]!;
  assert.equal(m.rps, 10);
  assert.equal(m.p50, 5);
  assert.equal(m.p95, 9);
  assert.equal(m.p99, 9);
  assert.equal(m.errorRate, 0.2);
  assert.equal(m.bytesPerSec, 1000);
});

test('statusCode 0 (engine-level failure) counts as error', () => {
  const a = new Aggregator();
  a.addBatch([
    ev({ statusCode: 0 }),
    ev({ statusCode: 200 }),
  ]);
  const out = a.drainAll();
  assert.equal(out[0]?.errorRate, 0.5);
});

test('drainAll empties the aggregator', () => {
  const a = new Aggregator();
  a.addBatch([ev({}), ev({ stepName: 'B' })]);
  assert.equal(a.size(), 2);
  a.drainAll();
  assert.equal(a.size(), 0);
});
