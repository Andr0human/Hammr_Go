import type { PerSecondMetric, RawEvent } from '@hammr/shared';

interface Bucket {
  second: number;
  stepName: string;
  latencies: number[];
  errorCount: number;
  bytesSum: number;
}

export interface AggregatorOptions {
  // How many seconds behind 'now' a bucket must be before we consider it closed.
  // Generators batch every ~1 s and the WS hop adds jitter; 2 s gives late events
  // a chance to land in their proper bucket without holding back live updates.
  watermarkSeconds?: number;
}

const DEFAULT_WATERMARK = 2;

// Per-test aggregator. The controller owns one of these per active test (v1 has
// at most one). Buckets are keyed by (stepName, second). The hot path is pure
// in-memory math on raw events: generators must NOT pre-aggregate percentiles,
// because merging percentiles across nodes is mathematically wrong.
export class Aggregator {
  private readonly buckets = new Map<string, Bucket>();
  private readonly watermarkSeconds: number;

  constructor(opts: AggregatorOptions = {}) {
    this.watermarkSeconds = opts.watermarkSeconds ?? DEFAULT_WATERMARK;
  }

  addBatch(events: RawEvent[]): void {
    for (const e of events) {
      const second = Math.floor(e.timestamp / 1000);
      const key = `${e.stepName}|${second}`;
      let b = this.buckets.get(key);
      if (!b) {
        b = { second, stepName: e.stepName, latencies: [], errorCount: 0, bytesSum: 0 };
        this.buckets.set(key, b);
      }
      b.latencies.push(e.latencyMs);
      if (e.statusCode === 0 || e.statusCode >= 400) b.errorCount++;
      b.bytesSum += e.responseBytes;
    }
  }

  // Drain every bucket whose second is older than (now - watermark). Returns
  // them as PerSecondMetric records, sorted by (second, stepName) for stable
  // log output. Buckets newer than the watermark stay in memory for next tick.
  flushClosed(nowMs: number = Date.now()): PerSecondMetric[] {
    const cutoff = Math.floor(nowMs / 1000) - this.watermarkSeconds;
    const out: PerSecondMetric[] = [];
    for (const [key, b] of this.buckets) {
      if (b.second > cutoff) continue;
      out.push(toMetric(b));
      this.buckets.delete(key);
    }
    out.sort((a, b) => a.second - b.second || a.stepName.localeCompare(b.stepName));
    return out;
  }

  // Force-drain every bucket regardless of watermark. Called once at end-of-test
  // so the final partial second isn't lost.
  drainAll(): PerSecondMetric[] {
    const out: PerSecondMetric[] = [];
    for (const b of this.buckets.values()) out.push(toMetric(b));
    this.buckets.clear();
    out.sort((a, b) => a.second - b.second || a.stepName.localeCompare(b.stepName));
    return out;
  }

  size(): number {
    return this.buckets.size;
  }
}

function toMetric(b: Bucket): PerSecondMetric {
  const sorted = b.latencies.slice().sort((x, y) => x - y);
  const count = sorted.length;
  return {
    second: b.second,
    stepName: b.stepName,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    rps: count,
    errorRate: count === 0 ? 0 : b.errorCount / count,
    bytesPerSec: b.bytesSum,
  };
}

// Nearest-rank percentile on a pre-sorted array. Matches the CLI's quick stats
// in scripts/generator-cli.ts so smoke-comparison stays apples-to-apples.
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] ?? 0;
}
