// Session 6 demo CLI: subscribes to the controller's Socket.IO channel and
// prints per-second metrics + lifecycle events as they arrive. Pair with
// `start-test.ts` in another shell to see live metrics hit the browser path
// instead of the controller's stdout.
//
// Usage:
//   tsx apps/node/scripts/watch-test.ts [--controller http://localhost:3000]
import { io as ioClient } from 'socket.io-client';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const controller = flag('--controller') ?? 'http://localhost:3000';
const socket = ioClient(controller, { transports: ['websocket'] });

socket.on('connect', () => {
  console.log(`connected to ${controller} (id=${socket.id})`);
  console.log('waiting for events… (Ctrl-C to exit)');
});

socket.on('connect_error', (err: Error) => {
  console.error(`connect_error: ${err.message}`);
});

socket.on('test:started', (payload: unknown) => {
  console.log(`\n[test:started] ${JSON.stringify(payload)}`);
});

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

socket.on('test:metrics', (payload: MetricsPayload) => {
  for (const m of payload.metrics) {
    const errPct = (m.errorRate * 100).toFixed(1);
    console.log(
      `  [${m.second}] ${m.stepName.padEnd(16)} rps=${String(m.rps).padStart(5)} ` +
        `p50=${String(m.p50).padStart(4)}  p95=${String(m.p95).padStart(4)}  p99=${String(m.p99).padStart(4)}  ` +
        `err=${errPct}%  bytes=${m.bytesPerSec}`,
    );
  }
});

socket.on('test:settled', (payload: unknown) => {
  console.log(`\n[test:settled] ${JSON.stringify(payload)}`);
});
