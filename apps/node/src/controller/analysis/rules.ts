import type { Finding, PerSecondMetric } from '@hammr/shared';

// Shutdown-tail trim: the final 1s of any run has depressed rps because only
// naturally-completed requests count (teardown-aborted requests are dropped
// at the engine — see engine.ts + docs/gotchas.md). The error/latency spike
// artifact no longer exists; we still trim 1s so the rps dip doesn't nudge
// saturation's "rps flat" gate on borderline runs.
const SHUTDOWN_TAIL_SECONDS = 1;

// Error-rate thresholds for the error-spike rule.
const ERROR_WARN = 0.01;
const ERROR_CRITICAL = 0.05;

// Step-imbalance multipliers.
const STEP_P95_RATIO = 2;
const STEP_ERROR_RATIO = 3;

// Saturation: require at least this many steady-state seconds to regress on.
// Drift is measured as (slope × n) / baseline_p95 — i.e. projected p95 change
// across the window as a fraction of the starting level. An absolute ms/s
// threshold is misleading: 2 ms/s is huge on a 20ms baseline and noise on a
// 2000ms baseline. RPS slope flatness is |slope| / mean(rps) < FLAT_RPS_REL.
// End-elevation guard uses medians of the first and last third of the window
// so 1–2 late transient spikes cannot, on their own, trip the rule.
const SATURATION_MIN_SECONDS = 10;
const SATURATION_REL_DRIFT = 0.2;
const SATURATION_END_ELEVATION = 1.2;
const FLAT_RPS_REL = 0.02;

// Latency-elevation rule: compare the load-ramping baseline (first 1–2 buckets
// of the trimmed run) against the steady-state median p95. A steady plateau
// sitting N× above opening load is the "system absorbed the traffic but at a
// degraded latency floor" signal — OLS slope misses this when the climb
// finishes before steady state starts.
const LATENCY_ELEVATION_WARN = 1.5;
const LATENCY_ELEVATION_CRITICAL = 3;
const BASELINE_BUCKETS = 2;

// Jitter rule: coefficient of variation of steady-state p95. Catches bimodal
// / unstable runs where latency swings bucket-to-bucket with no trend —
// saturation sees no drift, latency-elevation sees no plateau, and the run
// would otherwise be labelled healthy despite inconsistent UX.
// Empirically: flat healthy runs sit at CoV ≈ 0.05–0.15; the Opslyft run
// that motivated this rule was ≈ 0.5. 0.3 is a clean separator.
const JITTER_MIN_COV = 0.3;

export interface AnalyzeOptions {
  rampUpMs: number;
}

// Aggregated "per second" view: percentiles are weighted-averaged across
// steps by request count. This is an approximation (true percentile merge
// requires the underlying sketch), but it's fine for trend/spike detection —
// we care about *direction*, not the exact number.
interface AggregatedSecond {
  second: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  errorRate: number;
  errors: number;
}

export function analyze(metrics: PerSecondMetric[], opts: AnalyzeOptions): Finding[] {
  const agg = aggregateBySecond(metrics);
  const trimmed = trimTail(agg);
  const steady = steadyStateWindow(trimmed, opts.rampUpMs);

  const findings: Finding[] = [];

  const sat = saturationRule(steady);
  if (sat) findings.push(sat);

  const elev = latencyElevationRule(trimmed, steady);
  if (elev) findings.push(elev);

  const jit = jitterRule(steady);
  if (jit) findings.push(jit);

  const err = errorSpikeRule(trimmed, metrics);
  if (err) findings.push(err);

  const imb = stepImbalanceRule(metrics, opts.rampUpMs);
  if (imb) findings.push(imb);

  if (findings.length === 0) {
    findings.push(healthyFallback(steady));
  }
  return findings;
}

function aggregateBySecond(metrics: PerSecondMetric[]): AggregatedSecond[] {
  const bySecond = new Map<number, PerSecondMetric[]>();
  for (const m of metrics) {
    const list = bySecond.get(m.second);
    if (list) list.push(m);
    else bySecond.set(m.second, [m]);
  }
  const out: AggregatedSecond[] = [];
  for (const second of [...bySecond.keys()].sort((a, b) => a - b)) {
    const rows = bySecond.get(second)!;
    const totalRps = rows.reduce((s, r) => s + r.rps, 0);
    const totalErrors = rows.reduce((s, r) => s + r.rps * r.errorRate, 0);
    const w = totalRps > 0 ? totalRps : 1;
    const wavg = (k: 'p50' | 'p95' | 'p99') =>
      Math.round(rows.reduce((s, r) => s + r[k] * (r.rps || 1), 0) / (totalRps > 0 ? totalRps : rows.length));
    out.push({
      second,
      p50: wavg('p50'),
      p95: wavg('p95'),
      p99: wavg('p99'),
      rps: totalRps,
      errors: totalErrors,
      errorRate: totalRps > 0 ? totalErrors / totalRps : 0,
    });
  }
  return out;
}

function trimTail<T>(buckets: T[]): T[] {
  if (buckets.length <= SHUTDOWN_TAIL_SECONDS) return [];
  return buckets.slice(0, buckets.length - SHUTDOWN_TAIL_SECONDS);
}

function steadyStateWindow(trimmed: AggregatedSecond[], rampUpMs: number): AggregatedSecond[] {
  if (trimmed.length === 0) return [];
  const rampSeconds = Math.ceil(rampUpMs / 1000);
  const firstSecond = trimmed[0]!.second;
  const steadyStart = firstSecond + rampSeconds;
  return trimmed.filter((b) => b.second >= steadyStart);
}

// Simple least-squares slope of y against its index (1-unit x per bucket).
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function saturationRule(steady: AggregatedSecond[]): Finding | null {
  if (steady.length < SATURATION_MIN_SECONDS) return null;
  const p95s = steady.map((b) => b.p95);
  const rpsSeries = steady.map((b) => b.rps);
  const p95Slope = slope(p95s);
  const rpsSlope = slope(rpsSeries);
  const rpsMean = mean(rpsSeries);
  const rpsFlat = rpsMean === 0 ? true : Math.abs(rpsSlope) / rpsMean < FLAT_RPS_REL;
  if (!rpsFlat) return null;

  // End-elevation guard: medians of the first and last third. Resistant to
  // 1–2 tail spikes that would otherwise drag OLS slope above threshold even
  // though 19/21 buckets in the window are flat.
  const thirdSize = Math.max(1, Math.floor(steady.length / 3));
  const headMedian = median(p95s.slice(0, thirdSize));
  const tailMedian = median(p95s.slice(-thirdSize));
  if (headMedian <= 0) return null;
  if (tailMedian / headMedian < SATURATION_END_ELEVATION) return null;

  // Relative drift guard: projected drift across the window, expressed as a
  // fraction of the head median. Makes the threshold scale-free.
  const projectedDrift = (p95Slope * (steady.length - 1)) / headMedian;
  if (projectedDrift < SATURATION_REL_DRIFT) return null;

  return {
    severity: 'warn',
    rule: 'saturation',
    headline: 'p95 trending upward under flat load — likely saturation.',
    detail: `Steady-state p95 drifted from ~${Math.round(headMedian)}ms → ~${Math.round(tailMedian)}ms over ${steady.length}s while RPS stayed ~${Math.round(rpsMean)}/s.`,
  };
}

function jitterRule(steady: AggregatedSecond[]): Finding | null {
  if (steady.length < SATURATION_MIN_SECONDS) return null;
  const p95s = steady.map((b) => b.p95);
  const avg = mean(p95s);
  if (avg <= 0) return null;
  const variance = mean(p95s.map((v) => (v - avg) ** 2));
  const cov = Math.sqrt(variance) / avg;
  if (cov < JITTER_MIN_COV) return null;
  const min = Math.min(...p95s);
  const max = Math.max(...p95s);
  return {
    severity: 'warn',
    rule: 'jitter',
    headline: 'p95 is highly variable — inconsistent latency floor.',
    detail: `Steady-state p95 swings ${Math.round(min)}–${Math.round(max)}ms (coefficient of variation ${cov.toFixed(2)}); response times look bimodal rather than a stable plateau.`,
  };
}

function latencyElevationRule(
  trimmed: AggregatedSecond[],
  steady: AggregatedSecond[],
): Finding | null {
  if (trimmed.length < BASELINE_BUCKETS + SATURATION_MIN_SECONDS) return null;
  if (steady.length < SATURATION_MIN_SECONDS) return null;
  const baselineP95 = median(trimmed.slice(0, BASELINE_BUCKETS).map((b) => b.p95));
  const steadyP95 = median(steady.map((b) => b.p95));
  if (baselineP95 <= 0) return null;
  const ratio = steadyP95 / baselineP95;
  if (ratio < LATENCY_ELEVATION_WARN) return null;
  const critical = ratio >= LATENCY_ELEVATION_CRITICAL;
  return {
    severity: critical ? 'critical' : 'warn',
    rule: 'latency_elevation',
    headline: critical
      ? `p95 stabilised ${ratio.toFixed(1)}× above opening — system is absorbing load at a severely degraded floor.`
      : `p95 stabilised ${ratio.toFixed(1)}× above opening — system absorbed load at a degraded latency floor.`,
    detail: `Opening p95 ~${Math.round(baselineP95)}ms; steady-state median p95 ~${Math.round(steadyP95)}ms.`,
  };
}

function errorSpikeRule(
  trimmed: AggregatedSecond[],
  raw: PerSecondMetric[],
): Finding | null {
  let worst: AggregatedSecond | null = null;
  for (const b of trimmed) {
    if (b.errorRate > ERROR_WARN && (!worst || b.errorRate > worst.errorRate)) {
      worst = b;
    }
  }
  if (!worst) return null;
  const critical = worst.errorRate >= ERROR_CRITICAL;
  const stepRow = raw
    .filter((r) => r.second === worst!.second)
    .sort((a, b) => b.errorRate - a.errorRate)[0];
  const stepName = stepRow?.stepName ?? 'unknown';
  return {
    severity: critical ? 'critical' : 'warn',
    rule: 'error_spike',
    headline: critical
      ? 'Error-rate spike above 5% — target is failing under load.'
      : 'Error-rate spike above 1%.',
    detail: `Peak ${(worst.errorRate * 100).toFixed(2)}% errors at second ${worst.second} (step "${stepName}").`,
  };
}

function stepImbalanceRule(
  raw: PerSecondMetric[],
  rampUpMs: number,
): Finding | null {
  const rampSeconds = Math.ceil(rampUpMs / 1000);
  const allSeconds = [...new Set(raw.map((r) => r.second))].sort((a, b) => a - b);
  if (allSeconds.length <= SHUTDOWN_TAIL_SECONDS) return null;
  const firstSecond = allSeconds[0]!;
  const lastKept = allSeconds[allSeconds.length - 1 - SHUTDOWN_TAIL_SECONDS]!;
  const steadyStart = firstSecond + rampSeconds;

  const byStep = new Map<string, { p95s: number[]; errRates: number[]; reqs: number[] }>();
  for (const r of raw) {
    if (r.second < steadyStart || r.second > lastKept) continue;
    let entry = byStep.get(r.stepName);
    if (!entry) {
      entry = { p95s: [], errRates: [], reqs: [] };
      byStep.set(r.stepName, entry);
    }
    entry.p95s.push(r.p95);
    entry.errRates.push(r.errorRate);
    entry.reqs.push(r.rps);
  }

  const stepStats = [...byStep.entries()].map(([name, e]) => ({
    name,
    p95: mean(e.p95s),
    errorRate: mean(e.errRates),
  }));
  if (stepStats.length < 2) return null;

  let worstPair: { slow: string; fast: string; ratio: number; kind: 'p95' | 'error' } | null = null;
  for (const a of stepStats) {
    for (const b of stepStats) {
      if (a === b) continue;
      if (b.p95 > 0 && a.p95 / b.p95 >= STEP_P95_RATIO) {
        const ratio = a.p95 / b.p95;
        if (!worstPair || ratio > worstPair.ratio) {
          worstPair = { slow: a.name, fast: b.name, ratio, kind: 'p95' };
        }
      }
      if (b.errorRate > 0 && a.errorRate / b.errorRate >= STEP_ERROR_RATIO) {
        const ratio = a.errorRate / b.errorRate;
        if (!worstPair || ratio > worstPair.ratio) {
          worstPair = { slow: a.name, fast: b.name, ratio, kind: 'error' };
        }
      }
    }
  }
  if (!worstPair) return null;
  return {
    severity: 'warn',
    rule: 'step_imbalance',
    headline:
      worstPair.kind === 'p95'
        ? `Step "${worstPair.slow}" is ${worstPair.ratio.toFixed(1)}× slower than "${worstPair.fast}".`
        : `Step "${worstPair.slow}" errors ${worstPair.ratio.toFixed(1)}× more than "${worstPair.fast}".`,
    detail:
      worstPair.kind === 'p95'
        ? `Average steady-state p95 differs by ${worstPair.ratio.toFixed(1)}×; "${worstPair.slow}" is the likely bottleneck.`
        : `Steady-state error rate of "${worstPair.slow}" is ${worstPair.ratio.toFixed(1)}× higher than "${worstPair.fast}".`,
  };
}

function healthyFallback(steady: AggregatedSecond[]): Finding {
  if (steady.length === 0) {
    return {
      severity: 'ok',
      rule: 'healthy_fallback',
      headline: 'Run completed without detectable issues.',
      detail: 'Not enough steady-state data to summarise; no rules fired.',
    };
  }
  const avgP95 = Math.round(mean(steady.map((b) => b.p95)));
  const avgRps = Math.round(mean(steady.map((b) => b.rps)));
  const avgErr = mean(steady.map((b) => b.errorRate));
  return {
    severity: 'ok',
    rule: 'healthy_fallback',
    headline: 'No issues detected — the run looks healthy.',
    detail: `Steady-state p95 ≈ ${avgP95}ms at ~${avgRps} rps with ${(avgErr * 100).toFixed(2)}% errors.`,
  };
}
