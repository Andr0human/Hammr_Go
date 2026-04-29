import { createServer, type Server as HttpServer } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ClickHouseClient } from '@clickhouse/client';
import { ZodError } from 'zod';
import { logger } from '../../logger.js';
import { parseScenario } from '../../scenario/parse.js';
import { queryTestMetrics } from '../../db/metrics-query.js';
import { analyze } from '../analysis/rules.js';
import { buildRunSummary, compareRuns } from '../analysis/compare.js';
import { detectDimension, COMPARE_MIN_RUNS, COMPARE_MAX_RUNS, type Scenario } from '@hammr/shared';
import type { TestsDao } from '../../db/tests-dao.js';
import type { GeneratorPool } from '../gen-pool.js';
import type { Orchestrator } from '../orchestrator.js';

export interface RestServerOptions {
  port: number;
  testsDao: TestsDao;
  // Optional. If absent, GET /api/tests/:id/metrics returns 503.
  clickhouse?: ClickHouseClient;
}

export interface RestServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

// Shape returned on validation errors. Zod issues are flattened so clients
// get field paths + messages without having to walk the tree themselves.
interface ValidationErrorBody {
  error: 'validation_failed';
  issues: Array<{ path: string; message: string }>;
}

function zodToBody(err: ZodError): ValidationErrorBody {
  return {
    error: 'validation_failed',
    issues: err.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  };
}

export async function startRestServer(
  pool: GeneratorPool,
  orch: Orchestrator,
  opts: RestServerOptions,
): Promise<RestServer> {
  const app = express();
  // CLAUDE.md: scenario files larger than 1 MB are rejected at the edge.
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, generators: pool.size(), busy: orch.isBusy() });
  });

  app.get('/api/generators', (_req: Request, res: Response) => {
    res.json({
      generators: pool.list().map((g) => ({
        generatorId: g.generatorId,
        cores: g.cores,
        maxVUs: g.maxVUs,
        registeredAt: g.registeredAt,
      })),
    });
  });

  app.post('/api/tests', (req: Request, res: Response) => {
    let parsed;
    try {
      parsed = parseScenario(req.body);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(zodToBody(err));
      } else {
        // parseScenario throws plain Errors for semantic violations
        // (duplicate step names, duration <= rampUp). Those are still
        // validation failures from the client's point of view.
        res.status(400).json({ error: 'validation_failed', issues: [{ path: '(root)', message: (err as Error).message }] });
      }
      return;
    }

    if (orch.isBusy()) {
      res.status(409).json({ error: 'busy', activeTestId: orch.activeTestId() });
      return;
    }

    // startTest runs synchronously up to the trailing `return new Promise`,
    // so activeTestId() is readable immediately after. If anyone adds an
    // `await` early in startTest, this assumption breaks.
    const settle = orch.startTest({
      scenario: parsed.scenario,
      rampUpMs: parsed.rampUpMs,
      durationMs: parsed.durationMs,
    });
    const testId = orch.activeTestId();

    if (!testId) {
      settle.catch((err) => {
        res.status(500).json({ error: 'start_failed', message: (err as Error).message });
      });
      return;
    }

    res.status(202).json({ testId, status: 'running' });
    settle
      .then((result) => logger.info({ result }, 'test settled (background)'))
      .catch((err) => logger.error({ err }, 'test failed (background)'));
  });

  app.get('/api/tests', (req: Request, res: Response) => {
    const limit = parseIntQuery(req.query.limit, 50);
    const offset = parseIntQuery(req.query.offset, 0);
    const { tests, total } = opts.testsDao.list({ limit, offset });
    res.json({
      tests: tests.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        error: t.error,
      })),
      total,
      limit,
      offset,
    });
  });

  app.get('/api/tests/:id', (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const row = opts.testsDao.get(id);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({
      id: row.id,
      name: row.name,
      status: row.status,
      config: row.config,
      summary: row.summary,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      error: row.error,
    });
  });

  app.get('/api/tests/:id/metrics', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!opts.clickhouse) {
        res.status(503).json({ error: 'clickhouse_unavailable' });
        return;
      }
      const id = req.params.id ?? '';
      const row = opts.testsDao.get(id);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const metrics = await queryTestMetrics(opts.clickhouse, id);
      res.json({ testId: row.id, status: row.status, metrics });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/tests/:id/analysis', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!opts.clickhouse) {
        res.status(503).json({ error: 'clickhouse_unavailable' });
        return;
      }
      const id = req.params.id ?? '';
      const row = opts.testsDao.get(id);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status === 'running' || row.status === 'queued') {
        res.status(409).json({ error: 'test_not_complete', status: row.status });
        return;
      }
      let rampUpMs = 0;
      try {
        const parsed = parseScenario(row.config);
        rampUpMs = parsed.rampUpMs;
      } catch {
        // Config in SQLite was already validated at create time; if it fails to
        // re-parse, treat ramp as 0 rather than failing the whole analysis.
      }
      const metrics = await queryTestMetrics(opts.clickhouse, id);
      const findings = analyze(metrics, { rampUpMs });
      res.json({ testId: row.id, findings });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/compare', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!opts.clickhouse) {
        res.status(503).json({ error: 'clickhouse_unavailable' });
        return;
      }
      const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length < COMPARE_MIN_RUNS) {
        res.status(400).json({ error: 'too_few_runs', min: COMPARE_MIN_RUNS });
        return;
      }
      if (ids.length > COMPARE_MAX_RUNS) {
        res.status(400).json({ error: 'too_many_runs', max: COMPARE_MAX_RUNS });
        return;
      }

      const rows = ids.map((id) => ({ id, row: opts.testsDao.get(id) }));
      const missing = rows.filter((r) => !r.row).map((r) => r.id);
      if (missing.length > 0) {
        res.status(400).json({ error: 'not_found', ids: missing });
        return;
      }
      const incomplete = rows.filter((r) => r.row!.status === 'running' || r.row!.status === 'queued');
      if (incomplete.length > 0) {
        res.status(400).json({ error: 'test_not_complete', ids: incomplete.map((r) => r.id) });
        return;
      }

      const scenarios = rows.map((r) => r.row!.config as Scenario);
      const dim = detectDimension(scenarios);
      if (!dim.ok) {
        res.status(400).json({ error: dim.reason, differingFields: dim.differingFields });
        return;
      }

      // Metrics + per-run summaries run in parallel — each test is an
      // independent ClickHouse query and an independent analyze() pass.
      const runs = await Promise.all(
        rows.map(async (r) => {
          const scenario = r.row!.config as Scenario;
          const parsed = parseScenario(scenario);
          const metrics = await queryTestMetrics(opts.clickhouse!, r.id);
          const summary = buildRunSummary({
            testId: r.id,
            vus: scenario.config.users,
            targetUrl: scenario.baseUrl,
            metrics,
            rampUpMs: parsed.rampUpMs,
          });
          return {
            testId: r.id,
            name: r.row!.name,
            config: scenario,
            metrics,
            summary,
          };
        }),
      );

      const comparison = compareRuns(runs.map((r) => r.summary), dim.dimension);
      res.json({
        dimension: dim.dimension,
        runs: runs.map((r) => ({
          testId: r.testId,
          name: r.name,
          config: r.config,
          metrics: r.metrics,
          summary: r.summary,
        })),
        comparison,
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE is idempotent on state: if the test isn't the active one, we
  // 404 (already terminal) or 409 (unknown testId). Only the active test
  // can be stopped; historical rows can't be "un-terminated".
  app.delete('/api/tests/:id', (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const active = orch.activeTestId();
    if (active !== id) {
      const row = opts.testsDao.get(id);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.status(409).json({ error: 'not_active', status: row.status });
      return;
    }
    try {
      orch.stop(id);
      res.status(202).json({ testId: id, status: 'stopping' });
    } catch (err) {
      res.status(409).json({ error: 'stop_failed', message: (err as Error).message });
    }
  });

  // Centralised error handler. Anything that reaches here is a bug, so log it
  // loudly and keep the response shape consistent for the dashboard.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled REST error');
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  const httpServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  logger.info({ port: opts.port }, 'REST server listening');

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function parseIntQuery(v: unknown, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
