import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import type { GenMsg, PerSecondMetric, RawEvent, Scenario } from '@hammr/shared';
import { logger } from '../logger.js';
import { LoadEventsWriter, type WriterStats } from '../db/events-writer.js';
import type { TestsDao } from '../db/tests-dao.js';
import type { SelfStats } from '../self-stats.js';
import { Aggregator } from './aggregator.js';
import type { GeneratorPool } from './gen-pool.js';
import { splitVUs } from './split-vus.js';

export type TestState = 'queued' | 'running' | 'stopping' | 'completed' | 'failed';
export type TestEndReason = 'completed' | 'failed' | 'aborted';

interface ActiveTest {
  testId: string;
  name: string;
  scenario: Scenario;
  totalVUs: number;
  rampUpMs: number;
  durationMs: number;
  startedAt: number;
  state: TestState;
  perGen: Map<string, { vus: number; done: boolean }>;
  totalEvents: number;
  totalErrors: number;
  droppedEvents: number;
  durationTimer: NodeJS.Timeout;
  flushTimer: NodeJS.Timeout;
  endError?: string;
  // Set when the test was aborted via DELETE (not natural duration elapse).
  // Drives endReason='aborted' even if gens subsequently ack `done` cleanly.
  manualAbort: boolean;
}

export interface StartTestParams {
  scenario: Scenario;
  rampUpMs: number;
  durationMs: number;
}

export interface OrchestratorOptions {
  clickhouse?: ClickHouseClient;
  writeColdPath?: boolean;
  flushIntervalMs?: number;
  // When provided, the orchestrator persists lifecycle transitions
  // (running → completed/failed/aborted) to SQLite. Optional so unit tests
  // can run the orchestrator standalone.
  testsDao?: TestsDao;
  // Optional per-process self-instrumentation. When set, every incoming
  // metrics batch is counted here; start.ts exposes it in its per-minute log.
  selfStats?: SelfStats;
}

export interface TestResult {
  testId: string;
  state: TestState;
  endReason: TestEndReason;
  totalEvents: number;
  errors: number;
  droppedEvents: number;
  durationMs: number;
  error?: string;
}

// Live events the orchestrator emits. The browser Socket.IO server subscribes
// to these and fans them out to connected dashboards. Keeping this as a
// discriminated union (mirrors gen-pool.ts) lets callers do one `on` instead
// of three separate subscription methods.
export type OrchestratorEvent =
  | {
      type: 'test:started';
      testId: string;
      name: string;
      totalVUs: number;
      rampUpMs: number;
      durationMs: number;
      startedAt: number;
    }
  | { type: 'test:metrics'; testId: string; metrics: PerSecondMetric[] }
  | { type: 'test:settled'; testId: string; result: TestResult };

const FLUSH_INTERVAL = 1000;

export class Orchestrator {
  private active: ActiveTest | null = null;
  private aggregator: Aggregator | null = null;
  private writer: LoadEventsWriter | null = null;
  private pendingResolve: ((r: TestResult) => void) | null = null;
  private readonly poolUnsub: () => void;
  private readonly listeners = new Set<(ev: OrchestratorEvent) => void>();

  constructor(
    private readonly pool: GeneratorPool,
    private readonly opts: OrchestratorOptions = {},
  ) {
    this.poolUnsub = pool.on((ev) => {
      if (ev.type !== 'disconnected') return;
      if (!this.active) return;
      if (!this.active.perGen.has(ev.generatorId)) return;
      this.fail(`generator ${ev.generatorId} disconnected mid-test`);
    });
  }

  isBusy(): boolean {
    return (
      this.active !== null &&
      this.active.state !== 'completed' &&
      this.active.state !== 'failed'
    );
  }

  activeTestId(): string | null {
    return this.active?.testId ?? null;
  }

  on(listener: (ev: OrchestratorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startTest(params: StartTestParams): Promise<TestResult> {
    if (this.isBusy()) {
      throw new Error(`controller busy: test ${this.active!.testId} is ${this.active!.state}`);
    }
    const gens = this.pool.list();
    if (gens.length === 0) {
      throw new Error('no generators registered');
    }
    const totalVUs = params.scenario.config.users;
    const split = splitVUs(totalVUs, gens.map((g) => g.generatorId));

    const testId = randomUUID();
    const startedAt = Date.now();

    this.aggregator = new Aggregator();
    if (this.opts.writeColdPath !== false && this.opts.clickhouse) {
      this.writer = new LoadEventsWriter(this.opts.clickhouse, { testId });
    }

    const perGen = new Map<string, { vus: number; done: boolean }>();
    for (const g of gens) {
      const vus = split.get(g.generatorId) ?? 0;
      perGen.set(g.generatorId, { vus, done: false });
    }

    const durationTimer = setTimeout(() => {
      logger.info({ testId }, 'duration elapsed; broadcasting stop');
      this.broadcastStop();
    }, params.durationMs);
    durationTimer.unref();

    const flushTimer = setInterval(
      () => this.tick(),
      this.opts.flushIntervalMs ?? FLUSH_INTERVAL,
    );
    flushTimer.unref();

    this.active = {
      testId,
      name: params.scenario.name,
      scenario: params.scenario,
      totalVUs,
      rampUpMs: params.rampUpMs,
      durationMs: params.durationMs,
      startedAt,
      state: 'running',
      perGen,
      totalEvents: 0,
      totalErrors: 0,
      droppedEvents: 0,
      durationTimer,
      flushTimer,
      manualAbort: false,
    };

    // Persist the running-state row before dispatching to generators. If the
    // dispatch loop fails mid-way, fail() will update status to 'failed' so
    // the DB never observes a lingering 'running' row for a dead test.
    if (this.opts.testsDao) {
      try {
        this.opts.testsDao.insert({
          id: testId,
          name: params.scenario.name,
          status: 'running',
          config: params.scenario,
          createdAt: startedAt,
          startedAt,
        });
      } catch (err) {
        logger.error({ err, testId }, 'failed to persist test row');
      }
    }

    for (const g of gens) {
      const vus = split.get(g.generatorId) ?? 0;
      try {
        g.send({
          type: 'start',
          testId,
          scenario: params.scenario,
          vus,
          rampUpMs: params.rampUpMs,
          durationMs: params.durationMs,
        });
      } catch (err) {
        this.fail(`failed to dispatch start to ${g.generatorId}: ${(err as Error).message}`);
        return new Promise((resolve) => {
          this.pendingResolve = resolve;
        });
      }
    }

    logger.info(
      {
        testId,
        totalVUs,
        rampUpMs: params.rampUpMs,
        durationMs: params.durationMs,
        generators: gens.length,
        split: Object.fromEntries(split),
      },
      'test started',
    );

    this.emit({
      type: 'test:started',
      testId,
      name: params.scenario.name,
      totalVUs,
      rampUpMs: params.rampUpMs,
      durationMs: params.durationMs,
      startedAt,
    });

    return new Promise<TestResult>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  // Called by DELETE /api/tests/:id. Flags manualAbort so settle() picks
  // endReason='aborted' even when every generator replies `done` cleanly —
  // the user asked for a stop, so that's the honest reason.
  stop(testId: string): void {
    if (!this.active || this.active.testId !== testId) {
      throw new Error(`test ${testId} is not active`);
    }
    if (this.active.state !== 'running') return;
    this.active.state = 'stopping';
    this.active.manualAbort = true;
    logger.info({ testId }, 'manual stop requested');
    this.broadcastStop();
  }

  handleMessage(generatorId: string, msg: GenMsg): void {
    if (msg.type === 'register' || msg.type === 'pong') return;
    if (!this.active) return;
    if (msg.type !== 'metrics' && msg.type !== 'done' && msg.type !== 'error') return;
    if (msg.testId !== this.active.testId) {
      logger.debug(
        { from: generatorId, msgType: msg.type, msgTestId: msg.testId, active: this.active.testId },
        'dropping message for non-active test',
      );
      return;
    }

    switch (msg.type) {
      case 'metrics':
        this.onMetrics(generatorId, msg.batch, msg.droppedEvents ?? 0);
        break;
      case 'done':
        this.onDone(generatorId, msg.stats);
        break;
      case 'error':
        this.fail(`generator ${generatorId} reported error: ${msg.message}`);
        break;
    }
  }

  shutdown(): void {
    this.poolUnsub();
    this.listeners.clear();
    if (this.active) {
      clearTimeout(this.active.durationTimer);
      clearInterval(this.active.flushTimer);
    }
  }

  private emit(ev: OrchestratorEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (err) {
        logger.warn({ err }, 'orchestrator listener threw');
      }
    }
  }

  private onMetrics(generatorId: string, batch: RawEvent[], dropped: number): void {
    if (!this.active || !this.aggregator) return;
    this.active.totalEvents += batch.length;
    this.active.droppedEvents += dropped;
    for (const e of batch) {
      if (e.statusCode === 0 || e.statusCode >= 400) this.active.totalErrors++;
    }
    this.aggregator.addBatch(batch);
    this.writer?.push(batch);
    this.opts.selfStats?.recordEvents(batch.length);
    this.opts.selfStats?.recordDropped(dropped);
    if (dropped > 0) {
      logger.warn({ generatorId, dropped, testId: this.active.testId }, 'generator dropped events');
    }
  }

  // Introspection for the controller's self-stats tick. Cheap reads, no side
  // effects. Returns null fields when no test is active.
  introspect(): {
    activeTestId: string | null;
    aggregatorBuckets: number;
    writer: WriterStats | null;
  } {
    return {
      activeTestId: this.active?.testId ?? null,
      aggregatorBuckets: this.aggregator?.size() ?? 0,
      writer: this.writer?.stats() ?? null,
    };
  }

  private onDone(generatorId: string, stats: { totalEvents: number; errors: number }): void {
    if (!this.active) return;
    const slot = this.active.perGen.get(generatorId);
    if (!slot) return;
    slot.done = true;
    logger.info(
      { generatorId, testId: this.active.testId, stats },
      'generator reported done',
    );
    const allDone = Array.from(this.active.perGen.values()).every((s) => s.done);
    if (allDone) this.complete();
  }

  private broadcastStop(): void {
    if (!this.active) return;
    for (const generatorId of this.active.perGen.keys()) {
      const entry = this.pool.get(generatorId);
      if (!entry) continue;
      try {
        entry.send({ type: 'stop', testId: this.active.testId });
      } catch (err) {
        logger.warn({ generatorId, err }, 'failed to send stop');
      }
    }
  }

  private tick(): void {
    if (!this.active || !this.aggregator) return;
    const closed = this.aggregator.flushClosed();
    if (closed.length === 0) return;
    this.emit({ type: 'test:metrics', testId: this.active.testId, metrics: closed });
    for (const m of closed) {
      logger.info(
        {
          testId: this.active.testId,
          second: m.second,
          step: m.stepName,
          rps: m.rps,
          p50: m.p50,
          p95: m.p95,
          p99: m.p99,
          errPct: Number((m.errorRate * 100).toFixed(2)),
          bytes: m.bytesPerSec,
        },
        'live metric',
      );
    }
  }

  private complete(): void {
    if (!this.active) return;
    // Manual abort still settles through complete() once gens finish winding
    // down; we just report 'aborted' instead of 'completed'.
    const reason: TestEndReason = this.active.manualAbort ? 'aborted' : 'completed';
    this.active.state = 'completed';
    void this.settle(reason);
  }

  private fail(reason: string): void {
    if (!this.active || this.active.state === 'completed' || this.active.state === 'failed') return;
    this.active.state = 'failed';
    this.active.endError = reason;
    logger.error({ testId: this.active.testId, reason }, 'test failed');
    this.broadcastStop();
    void this.settle('failed');
  }

  private async settle(reason: TestEndReason): Promise<void> {
    const t = this.active;
    if (!t) return;
    clearTimeout(t.durationTimer);
    clearInterval(t.flushTimer);

    if (this.aggregator) {
      const tail = this.aggregator.drainAll();
      if (tail.length > 0) {
        this.emit({ type: 'test:metrics', testId: t.testId, metrics: tail });
        for (const m of tail) {
          logger.info(
            {
              testId: t.testId,
              second: m.second,
              step: m.stepName,
              rps: m.rps,
              p50: m.p50,
              p95: m.p95,
              p99: m.p99,
              errPct: Number((m.errorRate * 100).toFixed(2)),
              bytes: m.bytesPerSec,
              tail: true,
            },
            'live metric (tail)',
          );
        }
      }
    }

    if (this.writer) {
      try {
        await this.writer.close();
      } catch (err) {
        logger.error({ err, testId: t.testId }, 'writer close failed');
      }
    }

    const result: TestResult = {
      testId: t.testId,
      state: t.state,
      endReason: reason,
      totalEvents: t.totalEvents,
      errors: t.totalErrors,
      droppedEvents: t.droppedEvents,
      durationMs: Date.now() - t.startedAt,
      error: t.endError,
    };

    logger.info(
      {
        testId: t.testId,
        endReason: reason,
        totalEvents: result.totalEvents,
        errors: result.errors,
        droppedEvents: result.droppedEvents,
        durationMs: result.durationMs,
      },
      'test settled',
    );

    if (this.opts.testsDao) {
      // Map endReason → TestStatus. 'completed' stays completed;
      // 'failed' and 'aborted' each get their own terminal status.
      const status = reason;
      try {
        this.opts.testsDao.finish(
          t.testId,
          status,
          {
            totalEvents: result.totalEvents,
            errors: result.errors,
            droppedEvents: result.droppedEvents,
            durationMs: result.durationMs,
          },
          Date.now(),
          result.error ?? null,
        );
      } catch (err) {
        logger.error({ err, testId: t.testId }, 'failed to persist terminal state');
      }
    }

    this.emit({ type: 'test:settled', testId: t.testId, result });

    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.active = null;
    this.aggregator = null;
    this.writer = null;
    resolve?.(result);
  }
}
