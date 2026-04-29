// Empirical sweep: how many async VUs can one Worker Thread sustain before the
// event loop saturates? CLAUDE.md cites 32–64 target / 128 hard cap — those are
// k6/Artillery heuristics, not measurements on this codebase. This script pins
// threadCount=1, ramps through a VU ladder, and prints the knee so we can cite
// a real number.
//
// Pick a target that WON'T bottleneck. The Node echo-server saturates at
// ~870 rps (single-threaded on the same box competing for CPU). Use nginx in
// Docker, a remote endpoint, or anything with meaningful headroom.
//
// Usage:
//   tsx apps/node/scripts/sweep-vu-per-thread.ts \
//     [--target http://localhost:8080] \
//     [--path /] [--duration 30] [--ramp 3] \
//     [--vus 16,32,64,128,192,256,384,512]
import { parseScenario } from '@hammr/shared';
import { runTest } from '../src/generator/pool.js';
import { SelfStats } from '../src/self-stats.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const target = flag('--target') ?? 'http://localhost:8080';
// Default '/index.html' not '/' — Git-Bash on Windows rewrites a bare '/' arg
// into a Windows path (C:/Program Files/Git/), which silently breaks the URL.
const path = flag('--path') ?? '/index.html';
const durationSec = Number(flag('--duration') ?? 30);
const rampSec = Number(flag('--ramp') ?? 3);
const vuLadder = (flag('--vus') ?? '16,32,64,128,192,256,384,512')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

console.log(`[sweep] target=${target}${path}  duration=${durationSec}s  ramp=${rampSec}s`);
console.log(`[sweep] ladder=${vuLadder.join(',')}`);
console.log(`[sweep] threadCount=1 (pinned), maxVUsPerThread=${Math.max(...vuLadder)}`);

const { scenario } = parseScenario({
  name: 'sweep vu-per-thread',
  baseUrl: target,
  config: {
    users: 1,
    rampUp: `${rampSec}s`,
    duration: `${durationSec}s`,
    thinkTime: 0,
  },
  scenario: [{ name: 'probe', method: 'GET', path, thinkTime: 0 }],
});

interface Row {
  vus: number;
  rps: number;
  loopP50: number;
  loopP99: number;
  loopMax: number;
  cpuUser: number;
  cpuSys: number;
  events: number;
  errors: number;
  errPct: number;
}

const rows: Row[] = [];

for (const vus of vuLadder) {
  console.log(`\n[sweep] --- VUs=${vus} ---`);

  const stats = new SelfStats({ component: `sweep:vus=${vus}`, intervalMs: 10 * 60 * 1000 });
  stats.start();

  const result = await runTest({
    scenario,
    totalVUs: vus,
    rampUpMs: rampSec * 1000,
    durationMs: durationSec * 1000,
    threadCount: 1,
    maxVUsPerThread: Math.max(...vuLadder),
    onMetrics: (batch) => stats.recordEvents(batch.length),
  });

  const snap = stats.flush();
  stats.stop();

  const errPct = result.totalEvents === 0 ? 0 : (result.errors / result.totalEvents) * 100;

  rows.push({
    vus,
    rps: snap.rps,
    loopP50: snap.loopLagP50Ms,
    loopP99: snap.loopLagP99Ms,
    loopMax: snap.loopLagMaxMs,
    cpuUser: snap.cpuUserPct,
    cpuSys: snap.cpuSysPct,
    events: result.totalEvents,
    errors: result.errors,
    errPct: Number(errPct.toFixed(2)),
  });

  // Small cool-off so the next run starts from a quiesced event loop.
  await new Promise((r) => setTimeout(r, 1500));
}

const pad = (s: string | number, n: number): string => String(s).padStart(n);

console.log('\n[sweep] ============ Results ============');
console.log(
  `${pad('VUs', 5)}  ${pad('rps', 7)}  ${pad('loopP50', 8)}  ${pad('loopP99', 8)}  ${pad('loopMax', 8)}  ${pad('cpuU%', 7)}  ${pad('cpuS%', 7)}  ${pad('events', 7)}  ${pad('err%', 6)}`,
);
console.log('-'.repeat(90));
for (const r of rows) {
  console.log(
    `${pad(r.vus, 5)}  ${pad(r.rps, 7)}  ${pad(r.loopP50, 8)}  ${pad(r.loopP99, 8)}  ${pad(r.loopMax, 8)}  ${pad(r.cpuUser, 7)}  ${pad(r.cpuSys, 7)}  ${pad(r.events, 7)}  ${pad(r.errPct, 6)}`,
  );
}

// Knee heuristics. Cite whichever trips first as the practical cap for this
// target/host combo:
//   - rps stops growing (next rung is within 5% of the current one)
//   - loopLagP99 > 50 ms (event loop is backlogged — measurements get noisy)
//   - errors > 1% (engine-level failures creeping in)
console.log('\n[sweep] Knee analysis:');
let kneeByRps: number | null = null;
for (let i = 1; i < rows.length; i++) {
  const prev = rows[i - 1]!;
  const cur = rows[i]!;
  if (cur.rps < prev.rps * 1.05) {
    kneeByRps = prev.vus;
    break;
  }
}
const kneeByLag = rows.find((r) => r.loopP99 > 50)?.vus ?? null;
const kneeByErr = rows.find((r) => r.errPct > 1)?.vus ?? null;

console.log(`  rps plateau at VUs >= ${kneeByRps ?? 'never'} (< 5% gain to next rung)`);
console.log(`  loopP99 > 50ms first at VUs = ${kneeByLag ?? 'never'}`);
console.log(`  errors  >  1%  first at VUs = ${kneeByErr ?? 'never'}`);
console.log(
  '\n[sweep] The practical cap is the MIN of the three. Below it, rps rises cleanly and the event loop is healthy.',
);

process.exit(0);
