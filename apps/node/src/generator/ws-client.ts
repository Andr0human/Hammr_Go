import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { WebSocket } from 'ws';
import type { CtlMsg, GenMsg, RawEvent } from '@hammr/shared';
import { logger } from '../logger.js';
import { SelfStats } from '../self-stats.js';
import { runTest } from './pool.js';

export interface GeneratorClientOptions {
  controllerUrl: string;
  generatorId?: string;
  cores?: number;
  maxVUs?: number;
  // Backoff schedule for reconnect attempts (ms). Capped at the last entry.
  reconnectDelaysMs?: number[];
}

const DEFAULT_RECONNECT_DELAYS = [500, 1000, 2000, 5000, 10_000];
// Default upper bound on what we'll claim. The pool itself enforces
// VU-per-thread caps; this is just what we advertise to the controller.
const DEFAULT_MAX_VUS_PER_THREAD = 128;
// Backpressure threshold on the outbound WS. When the kernel/socket hasn't
// drained this much (in bytes) we drop the newest batch rather than grow
// unbounded. 8 MB ≈ 50K small events — matches the spec's 50K-or-10MB cap.
const WS_BUFFERED_DROP_BYTES = 8 * 1024 * 1024;

interface ActiveRun {
  testId: string;
  abort: AbortController;
  // Promise of the in-flight runTest. We don't await it inline — we let it
  // settle and post `done` from its .then. But on disconnect we need to wait
  // for it before allowing a clean process exit.
  finished: Promise<void>;
}

export interface GeneratorClient {
  // Resolves once the WS has closed and any in-flight test has finished.
  whenStopped: Promise<void>;
  stop: () => Promise<void>;
}

// Outbound WS client run by a generator process. Dials the controller, sends
// register on open, processes start/stop/ping, and pipes batched metrics back
// over the same socket.
//
// Reconnect policy: we DO reconnect after a controller restart so the next
// test can run. We do NOT auto-resume an in-flight test on reconnect — per
// CLAUDE.md, abort-on-disconnect is the failure semantics, and the controller
// will mark the test failed regardless of whether we reappear.
export function startGeneratorClient(opts: GeneratorClientOptions): GeneratorClient {
  const generatorId = opts.generatorId ?? `gen-${randomUUID().slice(0, 8)}`;
  const cores = opts.cores ?? Math.max(1, availableParallelism());
  const maxVUs = opts.maxVUs ?? cores * DEFAULT_MAX_VUS_PER_THREAD;
  const delays = opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;

  let stopRequested = false;
  let attempt = 0;
  let active: ActiveRun | null = null;
  let currentSocket: WebSocket | null = null;
  let stoppedResolve: (() => void) | null = null;
  let pendingDropped = 0;
  const whenStopped = new Promise<void>((r) => (stoppedResolve = r));

  const stats = new SelfStats({
    component: `generator:${generatorId}`,
    // bufferedAmount is the most useful signal for "am I about to drop?"
    // Read at tick time so the logged value reflects the current socket.
    extra: () => ({
      wsBufferedBytes: currentSocket?.bufferedAmount ?? 0,
      activeTestId: active?.testId ?? null,
    }),
  });
  stats.start();

  const send = (msg: GenMsg): void => {
    const ws = currentSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  const handleStart = (msg: Extract<CtlMsg, { type: 'start' }>): void => {
    if (active) {
      send({
        type: 'error',
        testId: msg.testId,
        message: `generator already running ${active.testId}`,
      });
      return;
    }
    const abort = new AbortController();
    logger.info(
      { testId: msg.testId, vus: msg.vus, rampUpMs: msg.rampUpMs, durationMs: msg.durationMs },
      'received start',
    );

    if (msg.vus === 0) {
      // Controller assigned us zero VUs (e.g. more gens than VUs). Acknowledge
      // immediately so the orchestrator's per-gen done-tracker completes.
      send({
        type: 'done',
        testId: msg.testId,
        stats: { totalEvents: 0, errors: 0 },
      });
      return;
    }

    const finished = runTest({
      scenario: msg.scenario,
      totalVUs: msg.vus,
      rampUpMs: msg.rampUpMs,
      durationMs: msg.durationMs,
      generatorId,
      abortSignal: abort.signal,
      onMetrics: (batch: RawEvent[]) => {
        const ws = currentSocket;
        // Drop-newest when the socket can't keep up. The earliest signal in a
        // degrading test is the one we want to preserve, so the older events
        // already in bufferedAmount win. CLAUDE.md spec §Backpressure.
        if (
          !ws ||
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > WS_BUFFERED_DROP_BYTES
        ) {
          pendingDropped += batch.length;
          stats.recordDropped(batch.length);
          return;
        }
        stats.recordEvents(batch.length);
        const drops = pendingDropped;
        pendingDropped = 0;
        send({ type: 'metrics', testId: msg.testId, batch, droppedEvents: drops });
      },
    })
      .then((result) => {
        // Flush any drops accumulated after the last metrics message so the
        // controller's running tally still sees them before `done`.
        if (pendingDropped > 0) {
          send({
            type: 'metrics',
            testId: msg.testId,
            batch: [],
            droppedEvents: pendingDropped,
          });
          pendingDropped = 0;
        }
        send({
          type: 'done',
          testId: msg.testId,
          stats: { totalEvents: result.totalEvents, errors: result.errors },
        });
        // End-of-test snapshot: short tests would never hit the per-minute
        // timer otherwise. `flush()` logs + resets so next test starts clean.
        stats.flush();
        logger.info(
          { testId: msg.testId, totalEvents: result.totalEvents, errors: result.errors },
          'test done; sent done',
        );
      })
      .catch((err) => {
        send({
          type: 'error',
          testId: msg.testId,
          message: err instanceof Error ? err.message : String(err),
        });
        logger.error({ err, testId: msg.testId }, 'runTest failed');
      })
      .finally(() => {
        if (active?.testId === msg.testId) active = null;
      });

    active = { testId: msg.testId, abort, finished };
  };

  const handleStop = (msg: Extract<CtlMsg, { type: 'stop' }>): void => {
    if (!active || active.testId !== msg.testId) return;
    logger.info({ testId: msg.testId }, 'received stop; aborting');
    active.abort.abort();
  };

  const connect = (): void => {
    if (stopRequested) return;
    logger.info({ controllerUrl: opts.controllerUrl, attempt }, 'dialing controller');

    const ws = new WebSocket(opts.controllerUrl);
    currentSocket = ws;

    ws.on('open', () => {
      attempt = 0;
      logger.info({ generatorId, cores, maxVUs }, 'connected; sending register');
      send({ type: 'register', generatorId, cores, maxVUs });
    });

    ws.on('message', (data) => {
      let msg: CtlMsg;
      try {
        msg = JSON.parse(data.toString()) as CtlMsg;
      } catch (err) {
        logger.warn({ err }, 'malformed controller message');
        return;
      }
      switch (msg.type) {
        case 'ping':
          send({ type: 'pong' });
          break;
        case 'start':
          handleStart(msg);
          break;
        case 'stop':
          handleStop(msg);
          break;
      }
    });

    ws.on('close', (code, reason) => {
      logger.warn(
        { code, reason: reason.toString(), hadActive: !!active },
        'controller socket closed',
      );
      currentSocket = null;
      // If we had a test running, abort it — we can no longer stream metrics
      // and the controller will already be marking it failed.
      if (active) {
        active.abort.abort();
      }
      if (stopRequested) {
        finishShutdown();
        return;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
      attempt++;
      setTimeout(connect, delay).unref();
    });

    ws.on('error', (err) => {
      logger.warn({ err: err.message }, 'controller socket error');
    });
  };

  const finishShutdown = async (): Promise<void> => {
    if (active) {
      try {
        await active.finished;
      } catch {
        // already logged
      }
    }
    stats.stop();
    stoppedResolve?.();
  };

  connect();

  return {
    whenStopped,
    stop: async () => {
      stopRequested = true;
      if (active) active.abort.abort();
      currentSocket?.close();
      await whenStopped;
    },
  };
}
