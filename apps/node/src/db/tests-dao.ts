import type Database from 'better-sqlite3';
import type { TestStatus } from '@hammr/shared';
import { getDb } from './sqlite.js';

// Row shape as stored in SQLite. `config` and `summary` live as JSON strings;
// DAO callers get typed objects via the helpers below.
export interface TestRow {
  id: string;
  name: string;
  status: TestStatus;
  config: unknown;
  summary: unknown | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

export interface InsertTestInput {
  id: string;
  name: string;
  status: TestStatus;
  config: unknown;
  createdAt: number;
  startedAt?: number;
}

export interface ListTestsOpts {
  limit?: number;
  offset?: number;
}

interface RawRow {
  id: string;
  name: string;
  status: TestStatus;
  config: string;
  summary: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  error: string | null;
}

function rowToTest(r: RawRow): TestRow {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    config: JSON.parse(r.config),
    summary: r.summary ? JSON.parse(r.summary) : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    error: r.error,
  };
}

export class TestsDao {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly countStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;
  private readonly finishStmt: Database.Statement;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    this.insertStmt = db.prepare(
      `INSERT INTO tests (id, name, status, config, created_at, started_at)
       VALUES (@id, @name, @status, @config, @createdAt, @startedAt)`,
    );
    this.getStmt = db.prepare(`SELECT * FROM tests WHERE id = ?`);
    this.listStmt = db.prepare(
      `SELECT * FROM tests ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.countStmt = db.prepare(`SELECT COUNT(*) as n FROM tests`);
    this.updateStatusStmt = db.prepare(
      `UPDATE tests SET status = ? WHERE id = ?`,
    );
    // finish() writes the terminal status, summary, ended_at, and optional error
    // in one statement so rows never observe a half-written end state.
    this.finishStmt = db.prepare(
      `UPDATE tests
         SET status = @status, summary = @summary, ended_at = @endedAt, error = @error
       WHERE id = @id`,
    );
  }

  insert(input: InsertTestInput): void {
    this.insertStmt.run({
      id: input.id,
      name: input.name,
      status: input.status,
      config: JSON.stringify(input.config),
      createdAt: input.createdAt,
      startedAt: input.startedAt ?? null,
    });
  }

  get(id: string): TestRow | null {
    const row = this.getStmt.get(id) as RawRow | undefined;
    return row ? rowToTest(row) : null;
  }

  list(opts: ListTestsOpts = {}): { tests: TestRow[]; total: number } {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);
    const rows = this.listStmt.all(limit, offset) as RawRow[];
    const total = (this.countStmt.get() as { n: number }).n;
    return { tests: rows.map(rowToTest), total };
  }

  updateStatus(id: string, status: TestStatus): void {
    this.updateStatusStmt.run(status, id);
  }

  finish(
    id: string,
    status: TestStatus,
    summary: unknown,
    endedAt: number,
    error: string | null,
  ): void {
    this.finishStmt.run({
      id,
      status,
      summary: JSON.stringify(summary),
      endedAt,
      error,
    });
  }
}
