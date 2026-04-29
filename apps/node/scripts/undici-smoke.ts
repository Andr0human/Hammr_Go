// Throwaway: validates that undici's pooled Agent gives us clean per-request latencies.
// Usage: tsx scripts/undici-smoke.ts <url> [--n 500] [--concurrency 32]
import { Agent, request } from 'undici';

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const url = process.argv[2];
if (!url) {
  console.error('usage: undici-smoke <url> [--n 500] [--concurrency 32]');
  process.exit(1);
}
const N = Number(arg('--n', '500'));
const C = Number(arg('--concurrency', '32'));

const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 60_000,
  connections: C,
  pipelining: 0,
});

const latencies: number[] = [];
let errors = 0;
let nextIndex = 0;

async function oneRequest(): Promise<void> {
  const t0 = performance.now();
  try {
    const res = await request(url, { dispatcher: agent });
    for await (const chunk of res.body) void chunk;
    if (res.statusCode >= 400) errors++;
  } catch {
    errors++;
  } finally {
    latencies.push(performance.now() - t0);
  }
}

async function worker(): Promise<void> {
  while (true) {
    const i = nextIndex++;
    if (i >= N) return;
    await oneRequest();
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: Math.min(C, N) }, () => worker()));
const elapsed = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const q = (p: number) => latencies[Math.floor((latencies.length - 1) * p)] ?? 0;
console.log(`requests:  ${latencies.length}`);
console.log(`errors:    ${errors}`);
console.log(`rps:       ${(latencies.length / elapsed).toFixed(1)}`);
console.log(`p50 (ms):  ${q(0.5).toFixed(1)}`);
console.log(`p95 (ms):  ${q(0.95).toFixed(1)}`);
console.log(`p99 (ms):  ${q(0.99).toFixed(1)}`);
console.log(`max (ms):  ${latencies.at(-1)?.toFixed(1) ?? '0'}`);

await agent.close();
