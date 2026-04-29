// Session 4 standalone demo: runs a scenario through the VU pool and streams
// raw events into ClickHouse load_events. The MV feeds load_metrics_1s.
//
// Usage:
//   tsx apps/node/scripts/generator-cli.ts --scenario <path.json> [--threads <n>] [--no-clickhouse]
//
// All other knobs (users, rampUp, duration, thinkTime, baseUrl, steps) come
// from the scenario JSON itself.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getClickHouse } from '../src/db/clickhouse.js';
import { LoadEventsWriter } from '../src/db/events-writer.js';
import { runTest } from '../src/generator/pool.js';
import { parseScenario } from '../src/scenario/parse.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): void {
  console.error(
    'usage: generator-cli --scenario <path.json> [--threads <n>] [--no-clickhouse]',
  );
}

const scenarioPath = flag('--scenario');
if (!scenarioPath) {
  usage();
  process.exit(1);
}

const threadCount = flag('--threads') ? Number(flag('--threads')) : undefined;
if (threadCount !== undefined && (!Number.isFinite(threadCount) || threadCount < 1)) {
  console.error('--threads must be a positive integer');
  process.exit(1);
}

const writeToClickHouse = !hasFlag('--no-clickhouse');
const testId = randomUUID();

const raw = JSON.parse(await readFile(resolve(scenarioPath), 'utf8'));
const parsed = parseScenario(raw);

let seen = 0;
const writer = writeToClickHouse ? new LoadEventsWriter(getClickHouse(), { testId }) : null;

const result = await runTest({
  scenario: parsed.scenario,
  totalVUs: parsed.scenario.config.users,
  rampUpMs: parsed.rampUpMs,
  durationMs: parsed.durationMs,
  threadCount,
  onMetrics: (batch) => {
    seen += batch.length;
    writer?.push(batch);
  },
});

if (writer) {
  await writer.close();
}
if (writeToClickHouse) {
  await getClickHouse().close();
}

const elapsedSec = result.durationMs / 1000;

// Per-step percentile breakdown.
const byStep = new Map<string, number[]>();
for (const e of result.events) {
  const arr = byStep.get(e.stepName) ?? [];
  arr.push(e.latencyMs);
  byStep.set(e.stepName, arr);
}

const q = (arr: number[], p: number): number =>
  arr.length ? (arr[Math.floor((arr.length - 1) * p)] ?? 0) : 0;

const ws = writer?.stats();

console.log('');
console.log(`scenario:      ${parsed.scenario.name}`);
console.log(`baseUrl:       ${parsed.scenario.baseUrl}`);
console.log(`testId:        ${testId}`);
console.log(`generatorId:   ${result.generatorId}`);
console.log(`elapsed (s):   ${elapsedSec.toFixed(2)}`);
console.log(`events:        ${result.totalEvents} (live-stream saw ${seen})`);
console.log(`errors:        ${result.errors}`);
console.log(`rps (avg):     ${(result.totalEvents / elapsedSec).toFixed(1)}`);
if (ws) {
  console.log(
    `clickhouse:    inserted=${ws.totalInserted} batches=${ws.totalBatches} dropped=${ws.droppedEvents} lastFlush=${ws.lastFlushMs}ms`,
  );
} else {
  console.log(`clickhouse:    disabled (--no-clickhouse)`);
}
console.log('');
console.log('per-step latency (ms):');
console.log(
  `  ${'step'.padEnd(24)} ${'count'.padStart(8)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}`,
);
for (const step of parsed.scenario.scenario) {
  const arr = (byStep.get(step.name) ?? []).slice().sort((a, b) => a - b);
  console.log(
    `  ${step.name.padEnd(24)} ${String(arr.length).padStart(8)} ${q(arr, 0.5).toFixed(1).padStart(8)} ${q(arr, 0.95).toFixed(1).padStart(8)} ${q(arr, 0.99).toFixed(1).padStart(8)} ${(arr.at(-1) ?? 0).toFixed(1).padStart(8)}`,
  );
}
