// Tiny Express echo server for the Session 3 demo. Simulates a login → search →
// apply flow against an in-memory target so the scenario engine can be
// exercised end-to-end without touching a real service.
//
// Usage: tsx apps/node/scripts/echo-server.ts [--port 4000]
import express from 'express';
import { randomUUID } from 'node:crypto';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const port = Number(flag('--port') ?? 4000);

const app = express();
app.use(express.json({ limit: '1mb' }));

const tokens = new Set<string>();

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'missing credentials' });
    return;
  }
  const token = `t_${randomUUID().replace(/-/g, '')}`;
  tokens.add(token);
  res.json({ token, user: { email } });
});

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const h = req.header('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(h);
  if (!match || !tokens.has(match[1]!)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.get('/api/jobs', requireAuth, (req, res) => {
  const q = String(req.query.q ?? '');
  res.json({
    query: q,
    results: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, title: `${q} role ${i + 1}` })),
  });
});

app.post('/api/jobs/:id/apply', requireAuth, (req, res) => {
  res.json({ jobId: req.params.id, status: 'submitted' });
});

app.listen(port, () => {
  console.log(`echo server listening on http://localhost:${port}`);
});
