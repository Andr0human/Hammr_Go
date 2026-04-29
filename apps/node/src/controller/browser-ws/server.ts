import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '../../logger.js';
import type { Orchestrator } from '../orchestrator.js';

export interface BrowserWsServer {
  close: () => Promise<void>;
}

// Mounts Socket.IO on the same HTTP server as Express, so browsers hit the
// public port (`:3000`) for both REST and live metrics. The channel is
// from-now-forward per CLAUDE.md session 6: a client connecting mid-test
// receives new per-second metrics from that moment on. Historical data lives
// behind GET /api/tests/:id/metrics (ClickHouse MV), not here.
//
// Events sent to the browser:
//   test:started  — a test became active
//   test:metrics  — per-second aggregated metrics (array of PerSecondMetric)
//   test:settled  — test ended (completed/failed/aborted) with final result
//
// Socket.IO namespace is the default '/', and all events broadcast to every
// connected client. V1 has at most one active test, so per-test rooms would
// be dead weight. When V2 lifts the single-test invariant, switch to rooms
// keyed by testId.
export function startBrowserWsServer(
  httpServer: HttpServer,
  orch: Orchestrator,
): BrowserWsServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
    // Match Express's body limit in spirit — browsers don't push data, so a
    // tiny buffer is plenty. Prevents a rogue client from allocating a big one.
    maxHttpBufferSize: 1e5,
  });

  const unsub = orch.on((ev) => {
    // Discriminated union from the orchestrator → event name + payload for
    // the browser. Payload stays flat (no wrapping) so the client can destructure.
    switch (ev.type) {
      case 'test:started':
        io.emit('test:started', {
          testId: ev.testId,
          name: ev.name,
          totalVUs: ev.totalVUs,
          rampUpMs: ev.rampUpMs,
          durationMs: ev.durationMs,
          startedAt: ev.startedAt,
        });
        break;
      case 'test:metrics':
        io.emit('test:metrics', { testId: ev.testId, metrics: ev.metrics });
        break;
      case 'test:settled':
        io.emit('test:settled', { testId: ev.testId, result: ev.result });
        break;
    }
  });

  io.on('connection', (socket) => {
    logger.debug({ id: socket.id }, 'browser connected');
    socket.on('disconnect', (reason) => {
      logger.debug({ id: socket.id, reason }, 'browser disconnected');
    });
  });

  return {
    close: async () => {
      unsub();
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
    },
  };
}
