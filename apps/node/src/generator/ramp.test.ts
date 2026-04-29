import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vuStartDelays, assignVUsToThreads, validateCapacity } from './ramp.js';

describe('vuStartDelays', () => {
  it('returns empty array when totalVUs is 0', () => {
    assert.deepEqual(vuStartDelays(0, 10_000), []);
  });

  it('returns all-zero delays when rampUpMs is 0', () => {
    assert.deepEqual(vuStartDelays(5, 0), [0, 0, 0, 0, 0]);
  });

  it('spaces VUs evenly across ramp window', () => {
    // 10 VUs over 1000ms → 100ms apart
    const delays = vuStartDelays(10, 1000);
    assert.equal(delays.length, 10);
    assert.equal(delays[0], 0);
    assert.equal(delays[1], 100);
    assert.equal(delays[5], 500);
    assert.equal(delays[9], 900);
  });

  it('first VU always starts at t=0', () => {
    assert.equal(vuStartDelays(1, 30_000)[0], 0);
    assert.equal(vuStartDelays(500, 60_000)[0], 0);
  });

  it('last VU starts strictly before rampUpMs', () => {
    for (const [u, r] of [
      [100, 30_000],
      [500, 60_000],
      [1, 1_000],
    ] as const) {
      const delays = vuStartDelays(u, r);
      assert.ok(
        delays.at(-1)! < r,
        `last delay ${delays.at(-1)} should be < rampUp ${r} for u=${u}`,
      );
    }
  });

  it('delays are monotonically non-decreasing', () => {
    const delays = vuStartDelays(137, 47_000);
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i]! >= delays[i - 1]!);
    }
  });

  it('rejects negative inputs', () => {
    assert.throws(() => vuStartDelays(-1, 1000));
    assert.throws(() => vuStartDelays(10, -1));
  });
});

describe('assignVUsToThreads', () => {
  it('round-robins VUs across threads', () => {
    const buckets = assignVUsToThreads(7, 3, 0);
    assert.equal(buckets.length, 3);
    assert.deepEqual(
      buckets.map((b) => b.map((v) => v.vuId)),
      [
        [0, 3, 6],
        [1, 4],
        [2, 5],
      ],
    );
  });

  it('balances VUs evenly when divisible', () => {
    const buckets = assignVUsToThreads(8, 4, 0);
    assert.deepEqual(
      buckets.map((b) => b.length),
      [2, 2, 2, 2],
    );
  });

  it('empty buckets are returned when totalVUs=0', () => {
    const buckets = assignVUsToThreads(0, 4, 0);
    assert.deepEqual(
      buckets.map((b) => b.length),
      [0, 0, 0, 0],
    );
  });

  it('preserves the ramp delay on each VU', () => {
    const buckets = assignVUsToThreads(4, 2, 2000);
    // global delays: [0, 500, 1000, 1500]
    // thread 0 gets VUs 0, 2 with delays 0, 1000
    // thread 1 gets VUs 1, 3 with delays 500, 1500
    assert.deepEqual(buckets[0], [
      { vuId: 0, delayMs: 0 },
      { vuId: 2, delayMs: 1000 },
    ]);
    assert.deepEqual(buckets[1], [
      { vuId: 1, delayMs: 500 },
      { vuId: 3, delayMs: 1500 },
    ]);
  });

  it('rejects invalid thread count', () => {
    assert.throws(() => assignVUsToThreads(10, 0, 1000));
    assert.throws(() => assignVUsToThreads(10, -1, 1000));
  });
});

describe('validateCapacity', () => {
  it('accepts totalVUs at the ceiling', () => {
    assert.doesNotThrow(() =>
      validateCapacity({ totalVUs: 512, threadCount: 4, maxVUsPerThread: 128 }),
    );
  });

  it('rejects totalVUs above the ceiling with a helpful message', () => {
    assert.throws(
      () => validateCapacity({ totalVUs: 1000, threadCount: 4, maxVUsPerThread: 128 }),
      /exceeds capacity/,
    );
  });
});
