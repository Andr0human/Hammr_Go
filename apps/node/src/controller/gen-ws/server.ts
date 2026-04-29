import { WebSocketServer, WebSocket } from 'ws';
import type { CtlMsg, GenMsg } from '@hammr/shared';
import { logger } from '../../logger.js';
import type { GeneratorPool } from '../gen-pool.js';
import type { Orchestrator } from '../orchestrator.js';

export interface GenWsServerOptions {
  port: number;
  // Heartbeat interval. CLAUDE.md spec is 10s; tests may want it tighter.
  pingIntervalMs?: number;
  // Allow N missed pongs before evicting the socket. 2 keeps us tolerant of
  // a single dropped packet over a flaky link.
  maxMissedPongs?: number;
}

const DEFAULT_PING_MS = 10_000;
const DEFAULT_MAX_MISSED = 2;

export interface GenWsServer {
  close: () => Promise<void>;
}

// `ws` server on :3001/gen. Each socket represents one generator. The server
// handles wire framing + heartbeats; routing of metrics/done/error is delegated
// to the orchestrator. Generator identity comes from the first `register` msg —
// we don't trust whatever the URL says.
export async function startGenWsServer(
  pool: GeneratorPool,
  orch: Orchestrator,
  opts: GenWsServerOptions,
): Promise<GenWsServer> {
  const wss = new WebSocketServer({ port: opts.port, path: '/gen' });
  const pingMs = opts.pingIntervalMs ?? DEFAULT_PING_MS;
  const maxMissed = opts.maxMissedPongs ?? DEFAULT_MAX_MISSED;

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  logger.info({ port: opts.port, path: '/gen' }, 'gen WS server listening');

  wss.on('connection', (ws: WebSocket, req) => {
    const remote = req.socket.remoteAddress ?? '?';
    let generatorId: string | null = null;
    let missedPongs = 0;

    const send = (msg: CtlMsg): void => {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error(`socket not open (state=${ws.readyState})`);
      }
      ws.send(JSON.stringify(msg));
    };

    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      missedPongs++;
      if (missedPongs > maxMissed) {
        logger.warn(
          { generatorId, remote, missed: missedPongs },
          'evicting unresponsive generator',
        );
        ws.terminate();
        return;
      }
      try {
        send({ type: 'ping' });
      } catch (err) {
        logger.warn({ generatorId, err }, 'ping send failed');
      }
    }, pingMs);
    heartbeat.unref();

    ws.on('message', (data) => {
      let msg: GenMsg;
      try {
        msg = JSON.parse(data.toString()) as GenMsg;
      } catch (err) {
        logger.warn({ remote, err }, 'malformed message; dropping');
        return;
      }

      // pong resets the missed counter regardless of who we think it is.
      if (msg.type === 'pong') {
        missedPongs = 0;
        return;
      }

      if (msg.type === 'register') {
        generatorId = msg.generatorId;
        pool.add({
          generatorId: msg.generatorId,
          cores: msg.cores,
          maxVUs: msg.maxVUs,
          registeredAt: Date.now(),
          send,
          disconnect: (reason) => {
            try {
              ws.close(1000, reason);
            } catch {
              ws.terminate();
            }
          },
        });
        logger.info(
          { generatorId, cores: msg.cores, maxVUs: msg.maxVUs, remote },
          'generator registered',
        );
        return;
      }

      // Every other message must come from a registered generator. Anything
      // arriving before `register` is silently dropped — a client that sent
      // metrics first is buggy; we don't want to associate them with anyone.
      if (!generatorId) {
        logger.warn({ remote, msgType: msg.type }, 'message before register; dropping');
        return;
      }
      orch.handleMessage(generatorId, msg);
    });

    ws.on('close', (code, reason) => {
      clearInterval(heartbeat);
      if (generatorId) {
        logger.info(
          { generatorId, code, reason: reason.toString() },
          'generator disconnected',
        );
        pool.remove(generatorId);
      }
    });

    ws.on('error', (err) => {
      logger.warn({ generatorId, err }, 'generator socket error');
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'gen WS server error');
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}
