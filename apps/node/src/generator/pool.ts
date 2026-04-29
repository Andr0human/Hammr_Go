import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { RawEvent, Scenario } from '@hammr/shared';
import { logger } from '../logger.js';
import { assignVUsToThreads, validateCapacity } from './ramp.js';
import type { ParentToThread, ThreadToParent } from './thread.js';

export interface RunTestParams {
  scenario: Scenario;
  totalVUs: number;
  rampUpMs: number;
  durationMs: number;
  threadCount?: number;
  maxVUsPerThread?: number;
  generatorId?: string;
  onMetrics?: (batch: RawEvent[]) => void;
  // External cancel: when this fires, every worker thread receives {type:'stop'}
  // and aborts its in-flight VUs. Workers still drain their tail buffers via the
  // 'done' message, so the parent's totalEvents stays accurate.
  abortSignal?: AbortSignal;
}

export interface RunTestResult {
  generatorId: string;
  totalEvents: number;
  errors: number;
  durationMs: number;
  events: RawEvent[];
}

const DEFAULT_MAX_VUS_PER_THREAD = 128;

export async function runTest(params: RunTestParams): Promise<RunTestResult> {
  const threadCount = params.threadCount ?? Math.max(1, availableParallelism());
  const maxVUsPerThread = params.maxVUsPerThread ?? DEFAULT_MAX_VUS_PER_THREAD;
  const generatorId = params.generatorId ?? `gen-${randomUUID().slice(0, 8)}`;

  validateCapacity({ totalVUs: params.totalVUs, threadCount, maxVUsPerThread });

  const buckets = assignVUsToThreads(params.totalVUs, threadCount, params.rampUpMs);

  const events: RawEvent[] = [];
  let totalEvents = 0;
  let errors = 0;

  const workerUrl = resolveWorkerUrl();
  const workerOpts = resolveWorkerOpts();

  logger.info(
    {
      generatorId,
      threadCount,
      totalVUs: params.totalVUs,
      rampUpMs: params.rampUpMs,
      durationMs: params.durationMs,
      scenarioName: params.scenario.name,
      baseUrl: params.scenario.baseUrl,
      steps: params.scenario.scenario.length,
    },
    'Starting generator pool',
  );

  const started = performance.now();
  const workers: Worker[] = [];
  const workerDone = buckets.map(
    (bucket, threadId) =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerUrl, workerOpts);
        workers[threadId] = worker;

        worker.on('messageerror', (err) =>
          logger.error({ threadId, err }, 'thread messageerror'),
        );

        worker.on('message', (msg: ThreadToParent) => {
          switch (msg.type) {
            case 'ready':
              logger.debug({ threadId, vus: bucket.length }, 'thread ready');
              break;
            case 'metrics':
              totalEvents += msg.batch.length;
              for (const e of msg.batch) if (e.statusCode === 0 || e.statusCode >= 400) errors++;
              events.push(...msg.batch);
              params.onMetrics?.(msg.batch);
              break;
            case 'done':
              if (msg.finalBatch.length > 0) {
                totalEvents += msg.finalBatch.length;
                for (const e of msg.finalBatch)
                  if (e.statusCode === 0 || e.statusCode >= 400) errors++;
                events.push(...msg.finalBatch);
                params.onMetrics?.(msg.finalBatch);
              }
              logger.debug({ threadId, stats: msg.stats }, 'thread done');
              // Resolve on 'done' rather than 'exit': 'exit' can fire before
              // the port's message queue has been dispatched to listeners.
              resolve();
              break;
            case 'error':
              logger.error({ threadId, message: msg.message }, 'thread reported error');
              reject(new Error(`thread ${threadId}: ${msg.message}`));
              break;
          }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`thread ${threadId} exited with code ${code}`));
        });

        const startMsg: ParentToThread = {
          type: 'start',
          threadId,
          generatorId,
          vus: bucket,
          scenario: params.scenario,
          durationMs: params.durationMs,
        };
        worker.postMessage(startMsg);
      }),
  );

  const onAbort = (): void => {
    for (const w of workers) {
      try {
        w.postMessage({ type: 'stop' } satisfies ParentToThread);
      } catch {
        // Worker may already be exiting; ignore.
      }
    }
  };
  if (params.abortSignal) {
    if (params.abortSignal.aborted) onAbort();
    else params.abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    await Promise.all(workerDone);
  } finally {
    params.abortSignal?.removeEventListener('abort', onAbort);
  }
  const elapsedMs = Math.round(performance.now() - started);

  return { generatorId, totalEvents, errors, durationMs: elapsedMs, events };
}

function resolveWorkerUrl(): URL {
  const runningFromSource = import.meta.url.endsWith('.ts');
  // Dev runs go through a .mjs bootstrap that registers the tsx loader inside
  // the Worker before importing thread.ts. Built runs load thread.js directly.
  const file = runningFromSource ? './_worker-bootstrap.mjs' : './thread.js';
  return new URL(file, import.meta.url);
}

function resolveWorkerOpts(): ConstructorParameters<typeof Worker>[1] {
  return {};
}
