import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TestsDao } from './tests-dao.js';

// Mirror of the SCHEMA in sqlite.ts. Kept inline so the DAO test stays
// hermetic — it doesn't depend on env or disk state.
const SCHEMA = `
CREATE TABLE tests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,
  config      TEXT NOT NULL,
  summary     TEXT,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  ended_at    INTEGER,
  error       TEXT
);
`;

function fresh(): { dao: TestsDao; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return { dao: new TestsDao(db), db };
}

test('insert + get round-trips', () => {
  const { dao } = fresh();
  dao.insert({
    id: 't1',
    name: 'demo',
    status: 'running',
    config: { baseUrl: 'http://x', users: 10 },
    createdAt: 1700000000000,
    startedAt: 1700000000001,
  });
  const row = dao.get('t1');
  assert.ok(row);
  assert.equal(row!.id, 't1');
  assert.equal(row!.name, 'demo');
  assert.equal(row!.status, 'running');
  assert.deepEqual(row!.config, { baseUrl: 'http://x', users: 10 });
  assert.equal(row!.summary, null);
  assert.equal(row!.startedAt, 1700000000001);
  assert.equal(row!.endedAt, null);
});

test('get returns null for unknown id', () => {
  const { dao } = fresh();
  assert.equal(dao.get('missing'), null);
});

test('list is DESC by created_at and respects limit/offset', () => {
  const { dao } = fresh();
  for (let i = 0; i < 5; i++) {
    dao.insert({
      id: `t${i}`,
      name: `n${i}`,
      status: 'completed',
      config: { i },
      // createdAt is ascending so DESC should return t4..t0 in that order
      createdAt: 1700000000000 + i * 1000,
    });
  }
  const page1 = dao.list({ limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.deepEqual(
    page1.tests.map((t) => t.id),
    ['t4', 't3'],
  );
  const page2 = dao.list({ limit: 2, offset: 2 });
  assert.deepEqual(
    page2.tests.map((t) => t.id),
    ['t2', 't1'],
  );
});

test('list clamps limit to sane range', () => {
  const { dao } = fresh();
  dao.insert({
    id: 'a',
    name: 'a',
    status: 'completed',
    config: {},
    createdAt: 1,
  });
  // Passing 0 / negative gets clamped up to 1; huge values clamped down to 200.
  const low = dao.list({ limit: 0 });
  assert.equal(low.tests.length, 1); // still returns, because at least 1
  const high = dao.list({ limit: 9999 });
  assert.equal(high.tests.length, 1);
});

test('updateStatus flips status and leaves summary/ended_at null', () => {
  const { dao } = fresh();
  dao.insert({ id: 't1', name: 'x', status: 'running', config: {}, createdAt: 1 });
  dao.updateStatus('t1', 'stopping' as never); // as never: TestStatus enum doesn't include stopping in shared types, but the DAO doesn't enforce — good test of the permissive contract
  // Read back as a raw row to prove the column write went through.
  const row = dao.get('t1');
  assert.equal(row!.status, 'stopping');
  assert.equal(row!.endedAt, null);
});

test('finish writes status + summary + ended_at + error atomically', () => {
  const { dao } = fresh();
  dao.insert({ id: 't1', name: 'x', status: 'running', config: {}, createdAt: 1 });
  dao.finish(
    't1',
    'failed',
    { totalEvents: 100, errors: 3, droppedEvents: 0, durationMs: 5000 },
    1700000005000,
    'gen disconnected',
  );
  const row = dao.get('t1');
  assert.equal(row!.status, 'failed');
  assert.deepEqual(row!.summary, {
    totalEvents: 100,
    errors: 3,
    droppedEvents: 0,
    durationMs: 5000,
  });
  assert.equal(row!.endedAt, 1700000005000);
  assert.equal(row!.error, 'gen disconnected');
});

test('finish with null error column stores SQL NULL (not string)', () => {
  const { dao } = fresh();
  dao.insert({ id: 't1', name: 'x', status: 'running', config: {}, createdAt: 1 });
  dao.finish('t1', 'completed', { totalEvents: 1 }, 2, null);
  const row = dao.get('t1');
  assert.equal(row!.error, null);
});
