# Hammr

A distributed HTTP load testing platform. Simulates thousands of concurrent users against any HTTP API, streams real-time metrics to a live dashboard, and stores per-request events in ClickHouse for historical analysis.

## What it does

- **Drives load** from one or more generator nodes, each running N Worker Threads × M async virtual users (VUs) per thread — the same concurrency model as k6, Artillery, and Locust.
- **Coordinates** generators from a single controller over persistent WebSocket connections. Generators dial out; the controller never needs to reach them.
- **Collects** per-request events (latency, status, bytes) and streams them to the controller, which aggregates across all generators in memory (hot path → live dashboard) and persists raw events to ClickHouse (cold path → historical reports).
- **Runs any HTTP scenario** defined in JSON: multi-step flows with JSONPath token extraction, `{{variable}}` interpolation, think time, and per-step error policy. Zero changes to the target app.

## Architecture (one-liner)

```
Browser ◀─Socket.IO─▶ Controller ◀─WS─▶ Generator(s) ─HTTP─▶ Target API
                         │
                         ├─▶ ClickHouse (raw events + per-second aggregates via MV)
                         └─▶ SQLite    (test metadata)
```

One Node.js binary, three roles selected at startup via `HAMMR_ROLE`:
- `controller` — REST + Socket.IO on `:3000`, generator WebSocket on `:3001`, owns the aggregator + writers.
- `generator` — dials the controller, runs the Worker Thread VU pool, streams raw events up.
- `standalone` — both, in one process. Default for local dev.

## Tech stack

TypeScript · Node 20+ · Express · Socket.IO · `ws` · Worker Threads · `undici` (pooled keep-alive) · ClickHouse · SQLite (`better-sqlite3`) · Next.js + MUI + Recharts · Docker Compose.

---

## Prerequisites

- **Node.js 20+** — check with `node --version`.
- **Docker Desktop** — the only host-level install needed for ClickHouse. No native ClickHouse install required.

## Project layout

```
hammr/
├── apps/
│   ├── node/              # single binary — controller | generator | standalone
│   │   ├── src/           # controller, generator, db, protocol, scenario
│   │   ├── migrations/    # ClickHouse SQL migrations
│   │   └── scripts/       # migrate-clickhouse, undici-smoke
│   └── web/               # Next.js dashboard
├── packages/
│   └── shared/            # scenario schema + WebSocket protocol types
├── docker-compose.yml     # local stack (ClickHouse, controller, generator)
└── .env.example           # all env vars with defaults
```

---

## Quick start

```bash
# 1. Install deps and copy env
npm install
cp .env.example .env

# 2. Bring up ClickHouse (pulls image on first run, ~30s)
docker compose up -d clickhouse

# 3. Apply migrations (idempotent — safe to re-run)
npm run migrate:clickhouse

# 4. Verify the HTTP client works end-to-end
npx tsx apps/node/scripts/undici-smoke.ts https://example.com --n 200 --concurrency 16
```

> Call the script via `npx tsx` (not `npm run`) when you need to pass flags.
> npm's arg forwarding drops `--`-prefixed flags on Windows.

The smoke test should print something like:

```
requests:  200
errors:    0
rps:       151.6
p50 (ms):  41.0
p95 (ms):  77.8
p99 (ms):  85.0
```

## Running the app

```bash
# Standalone (default): controller + generator in one process
npm run dev:node

# Explicit roles via env
HAMMR_ROLE=controller npm run dev:node
HAMMR_ROLE=generator  npm run dev:node
```

`dev:node` runs under `tsx watch` — auto-restarts on file save.

### Production build

```bash
npm run build                    # compiles @hammr/shared and @hammr/node
node apps/node/dist/index.js     # run compiled binary
```

---

## Script reference

All scripts run from the repo root.

| Script | What it does |
|---|---|
| `npm install` | Install all workspace dependencies |
| `npm run build` | Compile every workspace (`@hammr/shared`, `@hammr/node`) |
| `npm run build:shared` | Compile only `@hammr/shared` |
| `npm run build:node` | Compile only `@hammr/node` |
| `npm run dev:node` | Run the node binary under `tsx watch` |
| `npm run dev:web` | Next.js dashboard dev server |
| `npm run migrate:clickhouse` | Apply `apps/node/migrations/clickhouse/*.sql` in order |
| `npx tsx apps/node/scripts/undici-smoke.ts <url>` | HTTP client latency smoke test |
| `npm run lint` | ESLint across `apps/**` and `packages/**` |
| `npm run format` | Prettier write |
| `npm run format:check` | Prettier check (CI-friendly) |

### Docker Compose

| Command | What it does |
|---|---|
| `docker compose up -d clickhouse` | Start ClickHouse in the background |
| `docker compose ps` | See running containers |
| `docker compose logs -f clickhouse` | Tail ClickHouse logs |
| `docker compose down` | Stop containers (data persists in the named volume) |
| `docker compose down -v` | Stop and wipe all data (drops the `clickhouse_data` volume) |

### Inspecting ClickHouse

```bash
# Browser UI
open http://localhost:8123/play     # or visit in a browser

# CLI inside the container
docker exec -it hammr-clickhouse clickhouse-client --database hammr

# Quick table check from the host
curl -s "http://localhost:8123/?database=hammr" --data-binary "SHOW TABLES"
```

Expected tables after migration: `load_events`, `load_metrics_1s`, `load_metrics_1s_mv`.

---

## Configuration

All env vars live in [.env.example](.env.example). Copy it to `.env` — `dotenv` loads it automatically.

| Var | Default | Purpose |
|---|---|---|
| `HAMMR_ROLE` | `standalone` | `controller` \| `generator` \| `standalone` |
| `HAMMR_PUBLIC_PORT` | `3000` | REST + Socket.IO (browser) |
| `HAMMR_GEN_PORT` | `3001` | WebSocket for generators (internal) |
| `CONTROLLER_URL` | `ws://localhost:3001/gen` | Where a generator dials |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_DATABASE` | `hammr` | Database name |
| `SQLITE_PATH` | `./data/hammr.db` | Controller test metadata |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

---

## Troubleshooting

**`docker: command not found`** — Docker Desktop isn't running, or the shell was opened before it started. Open a fresh terminal after Docker Desktop is up.

**`ECONNREFUSED 127.0.0.1:8123`** on migrate — ClickHouse hasn't finished booting yet. Check `docker compose ps` for a `healthy` status or tail the logs. First-run boot can take 20–30s.

**Port 8123 or 9000 already in use** — another ClickHouse (or service) is bound. Change the host port in [docker-compose.yml](docker-compose.yml), or stop the conflicting process.

**Rebuilding from scratch** — `docker compose down -v && docker compose up -d clickhouse && npm run migrate:clickhouse`.
