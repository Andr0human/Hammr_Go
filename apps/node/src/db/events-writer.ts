import type { ClickHouseClient } from '@clickhouse/client';
import type { RawEvent } from '@hammr/shared';
import { logger } from '../logger.js';

export interface LoadEventsWriterOptions {
  testId: string;
  rowLimit?: number;
  flushIntervalMs?: number;
  bufferCap?: number;
}

export interface WriterStats {
  totalInserted: number;
  totalBatches: number;
  droppedEvents: number;
  lastFlushMs: number;
}

interface Row {
  test_id: string;
  step_name: string;
  generator_id: string;
  thread_id: number;
  vu_id: number;
  status_code: number;
  latency_ms: number;
  response_bytes: number;
  timestamp: string;
}

const DEFAULT_ROW_LIMIT = 5000;
const DEFAULT_FLUSH_MS = 1000;
// Hard memory cap: drop-newest above this (matches the backpressure spirit in
// CLAUDE.md; Session 4 writes direct to CH, Session 5 moves this cap to the
// generator→controller WS hop where the spec formally puts it).
const DEFAULT_BUFFER_CAP = 50_000;

export class LoadEventsWriter {
  private readonly testId: string;
  private readonly rowLimit: number;
  private readonly bufferCap: number;
  private readonly flushIntervalMs: number;
  private readonly buffer: Row[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;
  private totalInserted = 0;
  private totalBatches = 0;
  private droppedEvents = 0;
  private lastFlushMs = 0;

  constructor(
    private readonly client: ClickHouseClient,
    opts: LoadEventsWriterOptions,
  ) {
    this.testId = opts.testId;
    this.rowLimit = opts.rowLimit ?? DEFAULT_ROW_LIMIT;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.bufferCap = opts.bufferCap ?? DEFAULT_BUFFER_CAP;
    this.timer = setInterval(() => this.scheduleFlush(), this.flushIntervalMs);
    this.timer.unref();
  }

  push(events: RawEvent[]): void {
    if (this.closed) throw new Error('LoadEventsWriter.push after close');
    for (const e of events) {
      if (this.buffer.length >= this.bufferCap) {
        this.droppedEvents++;
        continue;
      }
      this.buffer.push({
        test_id: this.testId,
        step_name: e.stepName,
        generator_id: e.generatorId,
        thread_id: e.threadId,
        vu_id: e.vuId,
        status_code: e.statusCode,
        latency_ms: e.latencyMs,
        response_bytes: e.responseBytes,
        timestamp: toClickHouseDateTime64(e.timestamp),
      });
    }
    if (this.buffer.length >= this.rowLimit) this.scheduleFlush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.scheduleFlush();
    await this.flushChain;
  }

  stats(): WriterStats {
    return {
      totalInserted: this.totalInserted,
      totalBatches: this.totalBatches,
      droppedEvents: this.droppedEvents,
      lastFlushMs: this.lastFlushMs,
    };
  }

  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(
      () => this.doFlush(),
      () => this.doFlush(),
    );
  }

  private async doFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0, this.buffer.length);
    const started = performance.now();
    try {
      await this.client.insert({
        table: 'load_events',
        values: rows,
        format: 'JSONEachRow',
      });
      this.totalInserted += rows.length;
      this.totalBatches++;
      this.lastFlushMs = Math.round(performance.now() - started);
    } catch (err) {
      logger.error(
        { err, rows: rows.length, testId: this.testId },
        'load_events insert failed',
      );
      throw err;
    }
  }
}

// ClickHouse DateTime64(3) accepts 'YYYY-MM-DD HH:MM:SS.sss' in UTC via
// JSONEachRow without any format-hint tuning. Building the string from the ISO
// form avoids locale/TZ surprises on Windows.
function toClickHouseDateTime64(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10) + ' ' + iso.slice(11, 23);
}
