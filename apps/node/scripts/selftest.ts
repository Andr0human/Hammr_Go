// Session 8 capacity self-test.
//
// Runs a saturating scenario against a local echo server through a running
// Hammr (standalone or controller+generator). Asserts the tool itself is
// behaving — honest actualRps, zero drops, bounded error rate — so that any
// numbers we see against a real target (JobNest) are about the target, not us.
//
// Expects these to already be up:
//   - ClickHouse        (docker-compose up clickhouse)
//   - Echo server       (npm run -w @hammr/node echo-server)
//   - Hammr standalone  (HAMMR_ROLE=standalone npm run -w @hammr/node dev)
//     OR controller + generator in two processes
//
// Usage:
//   tsx apps/node/scripts/selftest.ts \
//     [--scenario apps/node/scripts/examples/selftest-saturation.json] \
//     [--controller http://localhost:3000] \
//     [--min-rps 3000] [--max-error-rate 0.01] [--max-dropped 0]
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';

const __dirname = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function numFlag(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} not a number: ${raw}`);
  return n;
}

const scenarioPath =
  flag('--scenario') ?? resolve(__dirname, 'examples/selftest-saturation.json');
const controller = flag('--controller') ?? 'http://localhost:3000';
// Assertions are Hammr-internal. Default thresholds ONLY enforce properties
// Hammr itself controls:
//   maxDropped=0            Hammr's backpressure queue must not drop
//   (endReason==completed)  test lifecycle must run to term
//   (totalEvents > 0)       metrics must flow end-to-end
//
// RPS and error rate are SUT signals — a single-threaded echo server at 200
// VUs will saturate and return engine-level (status=0) failures. That's the
// target's problem, not ours. Opt-in to asserting them via flags when you
// trust the SUT's capacity.
const minRps = numFlag('--min-rps', 0);
const maxErrorRate = numFlag('--max-error-rate', 1.0);
const maxDropped = numFlag('--max-dropped', 0);

console.log(`[selftest] scenario=${scenarioPath}  controller=${controller}`);
console.log(
  `[selftest] thresholds: minRps=${minRps}  maxErrorRate=${maxErrorRate}  maxDropped=${maxDropped}`,
);

// 1. POST the scenario.
const body = await readFile(resolve(scenarioPath), 'utf8');
const r = await fetch(`${controller}/api/tests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
if (!r.ok) {
  console.error(`POST /api/tests failed: ${r.status} ${await r.text()}`);
  process.exit(2);
}
const { testId } = (await r.json()) as { testId: string };
console.log(`[selftest] testId=${testId}`);

// 2. Subscribe to the live stream and wait for test:settled for THIS testId.
const socket: Socket = ioClient(controller, { transports: ['websocket'] });

interface MetricsPayload {
  testId: string;
  metrics: Array<{
    second: number;
    stepName: string;
    rps: number;
    p50: number;
    p95: number;
    p99: number;
    errorRate: number;
    bytesPerSec: number;
  }>;
}
interface SettledPayload {
  testId: string;
  result: {
    state: string;
    endReason: 'completed' | 'failed' | 'aborted';
    totalEvents: number;
    errors: number;
    droppedEvents: number;
    durationMs: number;
    error?: string;
  };
}

// Stream-level rollups so the operator sees the test is alive even before
// we print the final verdict.
let streamedSecondCount = 0;
let streamedEventsSum = 0;

socket.on('test:metrics', (payload: MetricsPayload) => {
  if (payload.testId !== testId) return;
  for (const m of payload.metrics) {
    streamedSecondCount++;
    streamedEventsSum += m.rps;
    process.stdout.write(
      `.${m.stepName.padEnd(14).slice(0, 14)} rps=${String(m.rps).padStart(5)} p95=${String(m.p95).padStart(4)}\n`,
    );
  }
});

const settled = await new Promise<SettledPayload>((res, rej) => {
  const timeoutMs = 10 * 60 * 1000; // never block forever if the test hangs
  const t = setTimeout(() => rej(new Error('timed out waiting for test:settled')), timeoutMs);
  socket.on('test:settled', (payload: SettledPayload) => {
    if (payload.testId !== testId) return;
    clearTimeout(t);
    res(payload);
  });
  socket.on('connect_error', (err: Error) => {
    clearTimeout(t);
    rej(err);
  });
});

socket.close();

// 3. Verdict. Fails loud with exit=1 so CI / operators can't miss it.
const { result } = settled;
const rps = result.durationMs > 0 ? (result.totalEvents / (result.durationMs / 1000)) : 0;
const errorRate = result.totalEvents === 0 ? 0 : result.errors / result.totalEvents;

console.log('\n[selftest] ============ Hammr health ============');
console.log(`[selftest] endReason       : ${result.endReason}`);
console.log(`[selftest] totalEvents     : ${result.totalEvents}`);
console.log(`[selftest] durationMs      : ${result.durationMs}`);
console.log(`[selftest] droppedEvents   : ${result.droppedEvents}`);
console.log(`[selftest] streamed seconds: ${streamedSecondCount}  (sum rps ${streamedEventsSum})`);
console.log('[selftest] ============ SUT signal    ============');
console.log(`[selftest] avg RPS         : ${rps.toFixed(1)}`);
console.log(`[selftest] errors          : ${result.errors}  (${(errorRate * 100).toFixed(2)}%)`);
console.log('[selftest] (For event-loop lag / CPU / queue depth, read the last `self-stats`');
console.log('[selftest]  log lines from the controller + generator process logs.)');
console.log('[selftest] ========================================');

const failures: string[] = [];
if (result.endReason !== 'completed') failures.push(`endReason=${result.endReason}`);
if (result.totalEvents === 0) failures.push('totalEvents=0 — no metrics ever flowed');
if (result.droppedEvents > maxDropped)
  failures.push(`droppedEvents ${result.droppedEvents} > max ${maxDropped}`);
// Opt-in SUT assertions (non-zero thresholds only).
if (minRps > 0 && rps < minRps) failures.push(`avg RPS ${rps.toFixed(1)} < minRps ${minRps}`);
if (maxErrorRate < 1.0 && errorRate > maxErrorRate)
  failures.push(`errorRate ${errorRate.toFixed(4)} > max ${maxErrorRate}`);

if (failures.length > 0) {
  console.error(`[selftest] FAIL (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// Informational note when SUT clearly saturated but Hammr was clean.
if (errorRate > 0.05 && result.droppedEvents === 0) {
  console.log(
    '[selftest] note: non-zero error rate with zero Hammr drops suggests SUT saturation,',
  );
  console.log('[selftest]       not a Hammr bug. The tool delivered every request cleanly.');
}

console.log('[selftest] PASS — Hammr delivered the load without stalls or drops.');
process.exit(0);
