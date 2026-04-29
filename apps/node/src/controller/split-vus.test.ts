import test from 'node:test';
import assert from 'node:assert/strict';
import { splitVUs } from './split-vus.js';

test('even split when totalVUs divisible by gen count', () => {
  const m = splitVUs(100, ['a', 'b', 'c', 'd']);
  assert.deepEqual(Array.from(m.values()), [25, 25, 25, 25]);
});

test('remainder goes to first N gens', () => {
  const m = splitVUs(103, ['a', 'b', 'c', 'd']);
  assert.deepEqual(Array.from(m.values()), [26, 26, 26, 25]);
});

test('single gen takes all', () => {
  const m = splitVUs(500, ['solo']);
  assert.equal(m.get('solo'), 500);
});

test('empty gen list returns empty map (caller must guard)', () => {
  const m = splitVUs(100, []);
  assert.equal(m.size, 0);
});

test('more gens than VUs: some gens get 0', () => {
  const m = splitVUs(2, ['a', 'b', 'c', 'd']);
  assert.deepEqual(Array.from(m.values()), [1, 1, 0, 0]);
});

test('preserves input ordering', () => {
  const m = splitVUs(7, ['z', 'y', 'x']);
  assert.deepEqual(Array.from(m.keys()), ['z', 'y', 'x']);
  assert.deepEqual(Array.from(m.values()), [3, 2, 2]);
});
