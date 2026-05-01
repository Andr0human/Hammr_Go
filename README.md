# Hammr_Go

A distributed HTTP load testing platform with a **Go generator** and a **TypeScript controller**, coordinated over a versioned WebSocket protocol. Simulates thousands of concurrent users against any HTTP API, streams real-time metrics to a live dashboard, and stores per-request events in ClickHouse for historical analysis.

This is the Go-generator fork of [Hammr](https://github.com/Andr0human/Hammr) — the load-driving runtime is rewritten in idiomatic Go (goroutine-per-VU, `context.Context` cancellation, `runtime/metrics` self-instrumentation), while the controller, dashboard, ClickHouse writer, and SQLite layer remain Node/TS. The wire protocol in `packages/shared/src/protocol.ts` is the cross-language contract.

## What it does

- **Drives load** from one or more Go generator nodes — one goroutine per virtual user (VU), with staggered ramp-up and a tuned shared `*http.Client` (`MaxIdleConnsPerHost = maxVUs`, 60 s keep-alive).
- **Coordinates** generators from a single Node controller over persistent WebSocket connections. Generators dial out; the controller never needs to reach them.
- **Collects** per-request events (latency, status, bytes), streams them to the controller, which aggregates across all generators in memory (hot path → live dashboard) and persists raw events to ClickHouse (cold path → historical reports).
- **Self-instruments** the Go generator via `runtime/metrics` — scheduler-latency histogram, GC pause distribution, heap-in-use, goroutine count — reported on the same per-minute cadence as the controller's own runtime stats.
- **Runs any HTTP scenario** defined in JSON: multi-step flows with JSONPath token extraction, `{{variable}}` interpolation, think time, and per-step error policy. Zero changes to the target app.

## Architecture

```
                     ┌──────────────────────────────────┐
 Browser ◀─Socket.IO─│  Controller (Node/TS)            │
 (dashboard)         │   :3000  REST + Socket.IO        │
                     │   :3001  ws server (generators)  │
                     │   SQLite · ClickHouse writer     │
                     │   Live aggregator (in-memory)    │
                     └──┬────────────────────┬──────────┘
                        ▲                    ▲
                 WS     │                    │   WS
              (bidir)   ▼                    ▼ (bidir)
                ┌──────────────┐      ┌──────────────┐
                │ Go Generator │ ...  │ Go Generator │
                │ goroutine-   │      │ goroutine-   │
                │   per-VU     │      │   per-VU     │
                └──────┬───────┘      └──────┬───────┘
                       │                     │
                       └──────────┬──────────┘
                                  ▼
                          Target HTTP API
```

Two independently-deployed binaries:

- **Controller** (Node) — `apps/node/`. REST + Socket.IO for the browser, `ws` server for generators. Owns SQLite (test metadata), ClickHouse writer, in-memory aggregator, test orchestration.
- **Generator** (Go) — `apps/go-generator/`. Standalone Go binary that dials the controller on startup, registers its capacity, and spawns one goroutine per VU.

## Tech stack

**Go side:** Go 1.22+ · `net/http` (tuned `Transport`) · `github.com/coder/websocket` · `runtime/metrics` for self-stats.

**TS side:** TypeScript · Node 20+ · Express · Socket.IO · `ws` · ClickHouse · SQLite (`better-sqlite3`) · Next.js + MUI + Recharts.

**Infra:** Docker Compose (local) · ECS Fargate (cloud generators) + EC2 (controller).

---

## Prerequisites

- **Go 1.22+** — `go version`
- **Node.js 20+** — `node --version`
- **Docker Desktop** running — only host install needed for ClickHouse.

## Project layout

```
hammr_go/
├── apps/
│   ├── go-generator/       # Go generator binary
│   │   ├── cmd/generator/  # entrypoint
│   │   └── internal/       # protocol, wsclient, pool, vu, httpclient, scenario, selfstats
│   ├── node/               # Node controller
│   │   ├── src/
│   │   │   ├── controller/ # rest, browser-ws, gen-ws, orchestrator, aggregator, analysis
│   │   │   ├── protocol/   # shared WebSocket message types
│   │   │   └── db/         # clickhouse, sqlite
│   │   ├── migrations/     # ClickHouse SQL migrations
│   │   └── scripts/        # migrate-clickhouse, selftest, undici-smoke
│   └── web/                # Next.js dashboard
├── packages/
│   └── shared/             # scenario schema (zod) + WebSocket protocol types — the cross-language contract
├── docker-compose.yml
└── .env.example
```

---

## Quick start

Three terminals: ClickHouse + controller, Go generator, dashboard.

### 1. Bring up ClickHouse and apply migrations

```bash
npm install
cp .env.example .env

docker compose up -d clickhouse
npm run migrate:clickhouse        # idempotent
```

### 2. Terminal A — Controller

```bash
HAMMR_ROLE=controller npm run dev:node
```

Listens on `:3000` (REST + Socket.IO for the dashboard) and `:3001` (WebSocket for generators).

> **PowerShell users:** `$env:HAMMR_ROLE="controller"; npm run dev:node`

### 3. Terminal B — Go generator

```bash
cd apps/go-generator

CONTROLLER_URL=ws://localhost:3001/gen \
GENERATOR_ID=go-1 \
MAX_VUS=2000 \
go run ./cmd/generator
```

The controller log should show `register` from `go-1` within ~1 s.

> **PowerShell:** `$env:CONTROLLER_URL="ws://localhost:3001/gen"; $env:GENERATOR_ID="go-1"; $env:MAX_VUS="2000"; go run ./cmd/generator`

Run more generators in additional terminals with different `GENERATOR_ID` values.

### 4. Terminal C — Dashboard

```bash
npm run dev:web
```

Open the URL printed by Next.js. Submit a test from `/tests/new` and watch metrics on `/results/[id]`.

### Production build

```bash
# Controller
npm run build
node apps/node/dist/index.js

# Generator
cd apps/go-generator
go build -o ../../bin/generator ./cmd/generator
./bin/generator
```

---

## Script reference

| Script | What it does |
|---|---|
| `npm install` | Install all workspace dependencies |
| `npm run build` | Compile every TS workspace (`@hammr/shared`, `@hammr/node`) |
| `npm run dev:node` | Run the controller under `tsx watch` |
| `npm run dev:web` | Next.js dashboard dev server |
| `npm run migrate:clickhouse` | Apply `apps/node/migrations/clickhouse/*.sql` in order |
| `npm run -w @hammr/node selftest` | End-to-end correctness check against a running generator |
| `npm run -w @hammr/node test` | Unit + integration tests (controller + analysis rules) |
| `go test ./...` *(in `apps/go-generator/`)* | Go-side unit tests (protocol round-trip, scenario engine, ramp pool) |
| `npm run lint` / `npm run format` | ESLint + Prettier |

### Docker Compose

| Command | What it does |
|---|---|
| `docker compose up -d clickhouse` | Start ClickHouse in the background |
| `docker compose logs -f clickhouse` | Tail ClickHouse logs |
| `docker compose down` | Stop containers (data persists in the named volume) |
| `docker compose down -v` | Stop and wipe all data (drops the `clickhouse_data` volume) |

### Inspecting ClickHouse

```bash
# Browser UI
open http://localhost:8123/play

# CLI inside the container
docker exec -it hammr-clickhouse clickhouse-client --database hammr

# Quick check from the host
curl -s "http://localhost:8123/?database=hammr" --data-binary "SHOW TABLES"
```

Expected tables after migration: `load_events`, `load_metrics_1s`, `load_metrics_1s_mv`.

---

## Configuration

All env vars live in [.env.example](.env.example). Copy it to `.env` — `dotenv` loads it on the controller; the Go generator reads its env directly from the shell.

### Controller (Node)

| Var | Default | Purpose |
|---|---|---|
| `HAMMR_ROLE` | *(required)* | Must be `controller` in this fork |
| `HAMMR_PUBLIC_PORT` | `3000` | REST + Socket.IO (browser) |
| `HAMMR_GEN_PORT` | `3001` | WebSocket for generators (internal) |
| `CLICKHOUSE_URL` | `http://localhost:8123` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_DATABASE` | `hammr` | Database name |
| `SQLITE_PATH` | `./data/hammr.db` | Controller test metadata |
| `LOG_LEVEL` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

### Generator (Go)

| Var | Default | Purpose |
|---|---|---|
| `CONTROLLER_URL` | `ws://localhost:3001/gen` | Where the generator dials |
| `GENERATOR_ID` | random | Stable identifier reported on `register` |
| `MAX_VUS` | `1024` | Capacity ceiling reported to the controller |

---

## Troubleshooting

**`docker: command not found`** — Docker Desktop isn't running, or the shell was opened before it started. Open a fresh terminal after Docker Desktop is up.

**`ECONNREFUSED 127.0.0.1:8123`** on migrate — ClickHouse hasn't finished booting yet. Check `docker compose ps` for a `healthy` status or tail the logs. First-run boot can take 20–30 s.

**Generator can't reach the controller** — confirm the controller is listening on the gen port (`netstat -ano | grep 3001`) and that `CONTROLLER_URL` matches `HAMMR_GEN_PORT`. The generator retries with backoff; logs show each `dialing controller` attempt.

**Port already in use** — another service is bound to `:3000`, `:3001`, `:8123`, or `:9000`. Stop the conflicting process or change the port in [docker-compose.yml](docker-compose.yml) / `.env`.

**Rebuilding from scratch** — `docker compose down -v && docker compose up -d clickhouse && npm run migrate:clickhouse`.
