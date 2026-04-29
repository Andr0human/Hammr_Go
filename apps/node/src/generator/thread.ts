import { parentPort } from 'node:worker_threads';
import type { RawEvent, Scenario } from '@hammr/shared';
import { createAgent } from './http.js';
import { runVU, type EventSink } from './vu.js';
import type { VUPlan } from './ramp.js';

export type ParentToThread =
  | {
      type: 'start';
      threadId: number;
      generatorId: string;
      vus: VUPlan[];
      scenario: Scenario;
      durationMs: number;
      flushIntervalMs?: number;
    }
  | { type: 'stop' };

export type ThreadToParent =
  | { type: 'ready'; threadId: number }
  | { type: 'metrics'; threadId: number; batch: RawEvent[] }
  | {
      type: 'done';
      threadId: number;
      // `finalBatch` carries any events still buffered at shutdown so the
      // parent can't miss them on a race with port close / worker exit.
      finalBatch: RawEvent[];
      stats: { totalEvents: number; errors: number; iterationsByVU: number };
    }
  | { type: 'error'; threadId: number; message: string };

if (!parentPort) {
  throw new Error('generator/thread.ts must run inside a Worker Thread');
}

const port = parentPort;
const controller = new AbortController();
let running = false;

port.on('message', (msg: ParentToThread) => {
  if (msg.type === 'stop') {
    controller.abort();
    return;
  }
  if (msg.type === 'start') {
    if (running) {
      port.postMessage({
        type: 'error',
        threadId: msg.threadId,
        message: 'thread already running a test',
      } satisfies ThreadToParent);
      return;
    }
    running = true;
    run(msg).catch((err) => {
      port.postMessage({
        type: 'error',
        threadId: msg.threadId,
        message: err instanceof Error ? err.message : String(err),
      } satisfies ThreadToParent);
    });
  }
});

async function run(cfg: Extract<ParentToThread, { type: 'start' }>): Promise<void> {
  const { threadId, generatorId, vus, scenario, durationMs } = cfg;
  const flushIntervalMs = cfg.flushIntervalMs ?? 1000;

  const agent = createAgent(vus.length);
  const buffer: RawEvent[] = [];
  let totalEvents = 0;
  let errors = 0;

  const sink: EventSink = (event) => {
    buffer.push(event);
    totalEvents++;
    if (event.statusCode === 0 || event.statusCode >= 400) errors++;
  };

  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);
    port.postMessage({ type: 'metrics', threadId, batch } satisfies ThreadToParent);
  };

  const flushTimer = setInterval(flush, flushIntervalMs);
  // Don't block the worker from exiting if we're the last ref.
  flushTimer.unref();

  port.postMessage({ type: 'ready', threadId } satisfies ThreadToParent);

  const start = performance.now();
  const endAt = start + durationMs;

  const vuPromises = vus.map(
    (plan) =>
      new Promise<void>((resolve) => {
        let launched = false;

        const launch = (): void => {
          launched = true;
          if (controller.signal.aborted || performance.now() >= endAt) {
            resolve();
            return;
          }
          runVU(
            {
              vuId: plan.vuId,
              threadId,
              generatorId,
              scenario,
              endAt,
            },
            agent,
            sink,
            controller.signal,
          )
            .catch(() => {
              // Per-VU crashes don't take down the thread; they surface as zero-status events.
            })
            .finally(() => resolve());
        };

        if (plan.delayMs <= 0) {
          launch();
          return;
        }

        const t = setTimeout(launch, plan.delayMs);
        // Abort during ramp: cancel the pending launch. Once launched, runVU
        // itself handles the signal and resolves via its finally() — we must
        // not resolve early or its tail-end sink call races with shutdown.
        controller.signal.addEventListener(
          'abort',
          () => {
            if (!launched) {
              clearTimeout(t);
              resolve();
            }
          },
          { once: true },
        );
      }),
  );

  // Hard deadline: once we pass endAt, abort any VU still in flight (drains a long
  // response or long think-time). VUs themselves also check endAt each iteration.
  const deadlineTimer = setTimeout(() => controller.abort(), durationMs);
  deadlineTimer.unref();

  await Promise.all(vuPromises);
  clearTimeout(deadlineTimer);
  clearInterval(flushTimer);

  const finalBatch = buffer.splice(0, buffer.length);
  await agent.close();

  port.postMessage({
    type: 'done',
    threadId,
    finalBatch,
    stats: { totalEvents, errors, iterationsByVU: vus.length },
  } satisfies ThreadToParent);

  // Release the last handle keeping the event loop alive so the worker exits
  // cleanly (Node otherwise holds the worker open on the parentPort listener).
  port.close();
}
