# Hammr Go Generator

The load generator binary for [Hammr](../../). Dials out to the Node controller over WebSocket, runs scenarios with one goroutine per virtual user, and streams metric batches back. Stateless — scale by running more generator processes.

This is the Go rewrite of what used to be the Node generator. The controller, dashboard, ClickHouse writer, and SQLite layer remain Node/TS. The wire protocol in [`packages/shared/src/protocol.ts`](../../packages/shared/src/protocol.ts) is the contract; Go struct definitions in [`internal/protocol`](internal/protocol/) match it field-for-field.

## Quickstart

Prerequisites: Go 1.23+, a running controller (`npm run -w @hammr/node dev` from the repo root) and ClickHouse (`docker-compose up clickhouse`).

```sh
cd apps/go-generator
go run ./cmd/generator
```

Submit a test through the controller's REST API or the dashboard (`apps/web`). The generator will appear in the controller logs as a `register` event and start receiving `start` messages.

## Env vars

All optional.

| Var | Default | Purpose |
|---|---|---|
| `CONTROLLER_URL` | `ws://localhost:3001/gen` | Controller's generator-side WebSocket endpoint |
| `GENERATOR_ID` | `gen-XXXXXXXX` (4 random bytes) | Identity advertised in `register` |
| `MAX_VUS` | `NumCPU * 128` | Capacity reported to controller; sizes the HTTP client's idle-conn pool |
| `OUTBOUND_CAPACITY` | `64` | Queue depth between batcher and WS writer; drop-newest kicks in past this |
| `BATCH_INTERVAL_MS` | `1000` | Metrics flush cadence |

## Layout

| Path | What's there |
|---|---|
| [`cmd/generator/`](cmd/generator/) | Main binary — wires WS client, pool, selfstats, signal handling |
| [`cmd/standalone-demo/`](cmd/standalone-demo/) | Offline harness: runs the pool against a target URL with no controller |
| [`internal/protocol/`](internal/protocol/) | Struct types matching `packages/shared/src/protocol.ts` |
| [`internal/wsclient/`](internal/wsclient/) | Connect, register, dispatch, drop-newest outbound buffer |
| [`internal/pool/`](internal/pool/) | VU lifecycle + ramp math |
| [`internal/vu/`](internal/vu/) | Single-VU loop |
| [`internal/httpclient/`](internal/httpclient/) | Tuned `*http.Transport` |
| [`internal/scenario/`](internal/scenario/) | Parse, JSONPath extract, interpolate, engine |
| [`internal/selfstats/`](internal/selfstats/) | `runtime/metrics`, RSS, goroutines, drop counters |

## Standalone demo

Useful when you want to load-test without booting the full controller stack:

```sh
go run ./cmd/standalone-demo -url http://localhost:8080 -vus 50 -duration 30s
```

See the file's `-help` for flag details.

## Running alongside the controller (local dev)

Two terminals:

```sh
# Terminal 1 — controller (also writes to ClickHouse on :8123)
docker-compose up -d clickhouse
npm run -w @hammr/node dev

# Terminal 2 — generator
cd apps/go-generator
go run ./cmd/generator
```

Submit a scenario via [`apps/node/scripts/start-test.ts`](../node/scripts/start-test.ts) or the dashboard. Logs from both processes use structured JSON; the controller logs the generator's `register` and `done` payloads, and the generator logs the `start`/`stop` it receives.

## Tests

```sh
go test ./...
```

Covers protocol round-trip vs captured fixtures, scenario parser parity with the TS implementation, ramp math, and the WS reconnect path.

## Acceptance gate

The cross-implementation contract is `npm run -w @hammr/node selftest` from the repo root. It runs the controller's standard saturation scenario against whatever generator is connected; the Go generator must keep it green (`droppedEvents = 0`). See [`docs/spec/go-generator.md`](../../docs/spec/go-generator.md) for the captured A/B numbers vs the previous Node generator.
