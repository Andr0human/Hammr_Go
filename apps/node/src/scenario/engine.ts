import { request, type Dispatcher } from 'undici';
import type { RawEvent, Scenario, ScenarioStep, ThinkTime } from '@hammr/shared';
import {
  interpolate,
  interpolateBody,
  interpolateHeaders,
  InterpolationError,
} from './interpolate.js';
import { extractPath, ExtractError } from './extract.js';

export type EventSink = (event: RawEvent) => void;

export interface VUIdentity {
  generatorId: string;
  threadId: number;
  vuId: number;
}

// Runs a single iteration of the scenario: every step in order, with a fresh
// variable context. Each step emits one RawEvent via the sink. On step failure
// the configured onError policy decides whether the iteration aborts or keeps
// running the remaining steps.
export async function runIteration(
  scenario: Scenario,
  agent: Dispatcher,
  sink: EventSink,
  signal: AbortSignal,
  identity: VUIdentity,
): Promise<void> {
  const vars: Record<string, unknown> = {};

  for (const step of scenario.scenario) {
    if (signal.aborted) return;

    const failed = await runStep(step, scenario.baseUrl, vars, agent, sink, signal, identity);

    const onError = step.onError ?? 'abort';
    if (failed && onError === 'abort') return;

    const thinkMs = resolveThinkTime(step.thinkTime ?? scenario.config.thinkTime);
    if (thinkMs > 0 && !signal.aborted) {
      await sleep(thinkMs, signal);
    }
  }
}

async function runStep(
  step: ScenarioStep,
  baseUrl: string,
  vars: Record<string, unknown>,
  agent: Dispatcher,
  sink: EventSink,
  signal: AbortSignal,
  identity: VUIdentity,
): Promise<boolean> {
  const t0 = performance.now();
  let statusCode = 0;
  let responseBytes = 0;
  let failed = false;

  try {
    const path = interpolate(step.path, vars);
    const url = joinUrl(baseUrl, path);
    const headers: Record<string, string> = interpolateHeaders(step.headers, vars) ?? {};
    const rawBody = step.body !== undefined ? interpolateBody(step.body, vars) : undefined;

    let bodyInit: string | undefined;
    if (rawBody !== undefined) {
      if (typeof rawBody === 'string') {
        bodyInit = rawBody;
      } else {
        bodyInit = JSON.stringify(rawBody);
        if (!hasHeader(headers, 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    const res = await request(url, {
      dispatcher: agent,
      method: step.method,
      headers,
      body: bodyInit,
      signal,
    });
    statusCode = res.statusCode;

    if (step.extract) {
      const text = await res.body.text();
      responseBytes = Buffer.byteLength(text);
      if (statusCode >= 400) {
        failed = true;
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          failed = true;
        }
        if (!failed) {
          for (const [key, pathExpr] of Object.entries(step.extract)) {
            try {
              vars[key] = extractPath(parsed, pathExpr);
            } catch (err) {
              if (err instanceof ExtractError) {
                failed = true;
                break;
              }
              throw err;
            }
          }
        }
      }
    } else {
      for await (const chunk of res.body) {
        responseBytes += (chunk as Buffer).length;
      }
      if (statusCode >= 400) failed = true;
    }
  } catch (err) {
    // Interpolation failure, network error, or abort. statusCode stays 0,
    // which the downstream aggregator treats as a non-response event.
    failed = true;
    if (err instanceof InterpolationError) {
      // Swallowed: we can't usefully surface this per-event in v1 metrics.
      // The failing step name + statusCode=0 is enough signal on the dashboard.
    }
  }

  // Drop test-teardown aborts: the request never completed, so counting it
  // as an error produces a misleading 100%-error tail in the last bucket.
  // NOTE: today the only AbortSignal wired into the request is the run-level
  // one, so any aborted request is a teardown. If per-request timeouts are
  // added later, this check must distinguish timeout-aborts from run-aborts.
  if (signal.aborted) return failed;

  const latencyMs = Math.max(0, Math.round(performance.now() - t0));
  sink({
    stepName: step.name,
    statusCode,
    latencyMs,
    responseBytes,
    timestamp: Date.now(),
    generatorId: identity.generatorId,
    threadId: identity.threadId,
    vuId: identity.vuId,
  });

  return failed;
}

export function resolveThinkTime(tt: ThinkTime | undefined): number {
  if (tt === undefined) return 0;
  if (typeof tt === 'number') return tt;
  if (tt.min >= tt.max) return tt.min;
  return tt.min + Math.floor(Math.random() * (tt.max - tt.min + 1));
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
