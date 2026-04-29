import { logger } from '../logger.js';
import { env } from '../env.js';
import { getClickHouse } from '../db/clickhouse.js';
import { TestsDao } from '../db/tests-dao.js';
import { SelfStats } from '../self-stats.js';
import { GeneratorPool } from './gen-pool.js';
import { Orchestrator } from './orchestrator.js';
import { startGenWsServer } from './gen-ws/server.js';
import { startRestServer } from './rest/server.js';
import { startBrowserWsServer } from './browser-ws/server.js';

export async function startController(): Promise<void> {
  const pool = new GeneratorPool();
  const clickhouse = getClickHouse();
  const testsDao = new TestsDao();

  // Self-stats is wired BEFORE the orchestrator so we can pass it in. `extra`
  // reads orchestrator internals at tick time — safe because introspect() is
  // read-only and returns nullable fields when no test is active.
  const orchRef: { current: Orchestrator | null } = { current: null };
  const stats = new SelfStats({
    component: 'controller',
    extra: () => {
      const o = orchRef.current;
      if (!o) return {};
      const s = o.introspect();
      return {
        activeTestId: s.activeTestId,
        aggregatorBuckets: s.aggregatorBuckets,
        writerInserted: s.writer?.totalInserted ?? 0,
        writerBatches: s.writer?.totalBatches ?? 0,
        writerDropped: s.writer?.droppedEvents ?? 0,
        writerLastFlushMs: s.writer?.lastFlushMs ?? 0,
        registeredGens: pool.list().length,
      };
    },
  });
  stats.start();

  const orch = new Orchestrator(pool, {
    clickhouse,
    writeColdPath: true,
    testsDao,
    selfStats: stats,
  });
  orchRef.current = orch;

  await startGenWsServer(pool, orch, { port: env.genPort });
  const rest = await startRestServer(pool, orch, {
    port: env.publicPort,
    testsDao,
    clickhouse,
  });
  // Socket.IO piggybacks on the REST HTTP server so browsers only need one
  // public port. io.attach() hooks into the 'upgrade' event without racing
  // Express's middleware chain.
  startBrowserWsServer(rest.httpServer, orch);

  // Emit a stats snapshot when each test settles so short tests still surface
  // a per-test row alongside the every-minute tick.
  orch.on((ev) => {
    if (ev.type === 'test:settled') stats.flush();
  });

  logger.info(
    { publicPort: env.publicPort, genPort: env.genPort },
    'Controller up (REST + browser WS on publicPort, generator WS on genPort/gen)',
  );
}
