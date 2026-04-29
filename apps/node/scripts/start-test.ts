// Session 5 demo CLI: posts a scenario to the controller's REST endpoint and
// polls (well, just logs) the testId. Live aggregates appear in the controller
// process's stdout — that's the Session 5 demo surface. Session 6 wires
// browser Socket.IO and a proper status endpoint.
//
// Usage:
//   tsx apps/node/scripts/start-test.ts --scenario <path.json> [--controller http://localhost:3000]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const scenarioPath = flag('--scenario');
if (!scenarioPath) {
  console.error('usage: start-test --scenario <path.json> [--controller <url>]');
  process.exit(1);
}

const controller = flag('--controller') ?? 'http://localhost:3000';
const body = await readFile(resolve(scenarioPath), 'utf8');

const r = await fetch(`${controller}/api/tests`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});

if (!r.ok) {
  const text = await r.text();
  console.error(`POST /api/tests failed: ${r.status} ${text}`);
  process.exit(1);
}

const json = (await r.json()) as { testId: string; status: string };
console.log(`testId: ${json.testId} (status: ${json.status})`);
console.log('watch the controller process stdout for live per-second aggregates.');

// Poll /api/generators once so the operator can confirm the fleet.
const gr = await fetch(`${controller}/api/generators`);
const gens = (await gr.json()) as { generators: Array<{ generatorId: string; cores: number; maxVUs: number }> };
console.log(`registered generators: ${gens.generators.length}`);
for (const g of gens.generators) {
  console.log(`  - ${g.generatorId}  cores=${g.cores}  maxVUs=${g.maxVUs}`);
}
