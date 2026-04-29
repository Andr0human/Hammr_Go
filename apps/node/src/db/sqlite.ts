import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../env.js';

let _db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tests (
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
CREATE INDEX IF NOT EXISTS idx_tests_created ON tests(created_at DESC);
`;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(env.sqlitePath), { recursive: true });
  _db = new Database(env.sqlitePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}
