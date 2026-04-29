import type { ComparisonDimension, Finding, PerSecondMetric } from '@hammr/shared';
import { analyze } from './rules.js';

export type RunShape = 'healthy' | 'spike-recover' | 'monotonic-climb' | 'elevated-plateau';

export interface RunSummary {
  testId: string;
  vus: number;
  targetUrl: string;
  steadyStateP95: number;
  steadyStateRps: number;
  errorRate: number;
  shape: RunShape;
  findings: Finding[];
}

// Scaling-efficiency floor: a 30% gap between actual and linear scaling is
// the signal. Below this, the second data point is holding the first back
// (queueing, pool exhaustion, CPU saturation) rather than scaling with it.
const SCALING_FLOOR = 0.7;
// Latency blowup: 2× latency for ≤ 2× load is the knee signal.
const BLOWUP_RATIO = 2;
// Error escalation thresholds — mirror Phase 1 error_spike levels so
// single-run and cross-run views agree on what "bad" means.
const ERROR_WARN = 0.01;
const ERROR_CRITICAL = 0.05;
// URL-comparison thresholds (same load, same scenario — differences are
// attributable to the target itself).
const URL_LATENCY_RATIO = 2;
const URL_ERROR_RATIO = 3;
const URL_ERROR_ABSOLUTE = 0.01;
const URL_RPS_FLOOR = 0.7;

export interface RunInput {
  testId: string;
  vus: number;
  targetUrl: string;
  metrics: PerSecondMetric[];
  rampUpMs: number;
}

export function buildRunSummary(input: RunInput): RunSummary {
  const { testId, vus, targetUrl, metrics, rampUpMs } = input;
  const findings = analyze(metrics, { rampUpMs });
  const steady = steadyStateRows(metrics, rampUpMs);
  const weight = steady.reduce((s, r) => s + r.rps, 0);
  const steadyStateP95 = weight > 0
    ? steady.reduce((s, r) => s + r.p95 * r.rps, 0) / weight
    : meanOf(steady.map((r) => r.p95));
  const secondsSpan = new Set(steady.map((r) => r.second)).size || 1;
  const steadyStateRps = steady.reduce((s, r) => s + r.rps, 0) / secondsSpan;
  const errorRate = weight > 0
    ? steady.reduce((s, r) => s + r.errorRate * r.rps, 0) / weight
    : 0;
  return {
    testId,
    vus,
    targetUrl,
    steadyStateP95,
    steadyStateRps,
    errorRate,
    shape: classifyShape(findings),
    findings,
  };
}

export function classifyShape(findings: Finding[]): RunShape {
  const rules = new Set(findings.map((f) => f.rule));
  if (rules.has('saturation')) return 'monotonic-climb';
  if (rules.has('latency_elevation') || rules.has('jitter')) return 'elevated-plateau';
  if (rules.has('error_spike')) return 'spike-recover';
  return 'healthy';
}

export function compareRuns(runs: RunSummary[], dimension: ComparisonDimension): Finding[] {
  if (runs.length < 2) return [];
  if (dimension === 'vu_count') {
    const sorted = [...runs].sort((a, b) => a.vus - b.vus);
    return analyzeVuSweep(sorted);
  }
  const sorted = [...runs].sort((a, b) => (a.targetUrl < b.targetUrl ? -1 : 1));
  return analyzeUrlCompare(sorted);
}

function analyzeVuSweep(runs: RunSummary[]): Finding[] {
  const out: Finding[] = [];

  let worstScale: { a: RunSummary; b: RunSummary; eff: number } | null = null;
  let worstBlow: { a: RunSummary; b: RunSummary; ratio: number } | null = null;
  let kneeIdx: number | null = null;

  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1]!;
    const b = runs[i]!;
    const vuRatio = b.vus / a.vus;
    if (vuRatio <= 0) continue;
    const rpsRatio = a.steadyStateRps > 0 ? b.steadyStateRps / a.steadyStateRps : 1;
    const eff = rpsRatio / vuRatio;
    if (eff < SCALING_FLOOR && (!worstScale || eff < worstScale.eff)) {
      worstScale = { a, b, eff };
    }
    if (a.steadyStateP95 > 0) {
      const pRatio = b.steadyStateP95 / a.steadyStateP95;
      if (pRatio > BLOWUP_RATIO && vuRatio <= 2) {
        if (!worstBlow || pRatio > worstBlow.ratio) worstBlow = { a, b, ratio: pRatio };
      }
    }
    const errorCrossed = a.errorRate < ERROR_WARN && b.errorRate >= ERROR_WARN;
    if (kneeIdx === null && (eff < SCALING_FLOOR || (a.steadyStateP95 > 0 && b.steadyStateP95 / a.steadyStateP95 > BLOWUP_RATIO) || errorCrossed)) {
      kneeIdx = i;
    }
  }

  if (worstScale) {
    const { a, b, eff } = worstScale;
    out.push({
      severity: 'warn',
      rule: 'scaling_efficiency',
      headline: `Throughput scaling broke down between ${a.vus} and ${b.vus} VUs.`,
      detail: `${(b.vus / a.vus).toFixed(1)}× load (${a.vus}→${b.vus} VU) produced ${(b.steadyStateRps / Math.max(a.steadyStateRps, 1)).toFixed(2)}× throughput (efficiency ${eff.toFixed(2)}, floor ${SCALING_FLOOR}).`,
    });
  }

  if (worstBlow) {
    const { a, b, ratio } = worstBlow;
    out.push({
      severity: 'warn',
      rule: 'latency_blowup',
      headline: `p95 grew ${ratio.toFixed(1)}× when load grew ${(b.vus / a.vus).toFixed(1)}×.`,
      detail: `${a.vus} VU → p95 ~${Math.round(a.steadyStateP95)}ms; ${b.vus} VU → p95 ~${Math.round(b.steadyStateP95)}ms.`,
    });
  }

  let worstErr: RunSummary | null = null;
  for (const r of runs) {
    if (!worstErr || r.errorRate > worstErr.errorRate) worstErr = r;
  }
  if (worstErr && worstErr.errorRate >= ERROR_WARN) {
    const severity: Finding['severity'] = worstErr.errorRate >= ERROR_CRITICAL ? 'critical' : 'warn';
    const idx = runs.indexOf(worstErr);
    const prev = idx > 0 ? runs[idx - 1]! : null;
    const detail = prev
      ? `${worstErr.vus} VU → ${(worstErr.errorRate * 100).toFixed(2)}% error; previous rung ${prev.vus} VU → ${(prev.errorRate * 100).toFixed(2)}%.`
      : `${worstErr.vus} VU → ${(worstErr.errorRate * 100).toFixed(2)}% error.`;
    out.push({
      severity,
      rule: 'error_escalation',
      headline: `Error rate reached ${(worstErr.errorRate * 100).toFixed(2)}% at ${worstErr.vus} VUs.`,
      detail,
    });
  }

  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1]!;
    const b = runs[i]!;
    const aRecovered = a.shape === 'healthy' || a.shape === 'spike-recover';
    if (aRecovered && b.shape === 'monotonic-climb') {
      out.push({
        severity: 'critical',
        rule: 'shape_divergence',
        headline: `System recovered at ${a.vus} VUs but could not recover at ${b.vus} VUs.`,
        detail: `Lower-load run shape "${a.shape}"; higher-load run shape "${b.shape}" — you've crossed the capacity knee.`,
      });
      break;
    }
  }

  if (runs.length >= 3 && kneeIdx !== null) {
    const a = runs[kneeIdx - 1]!;
    const b = runs[kneeIdx]!;
    out.push({
      severity: 'info',
      rule: 'capacity_knee',
      headline: `Capacity knee between ${a.vus} and ${b.vus} VUs.`,
      detail: `Scaling efficiency or latency first breaks below threshold at this step; lower-load rungs scaled cleanly.`,
    });
  }

  if (out.length === 0) {
    out.push({
      severity: 'ok',
      rule: 'vu_sweep_healthy',
      headline: 'Throughput and latency scaled cleanly across all VU levels.',
      detail: `${runs.length} runs (${runs.map((r) => r.vus).join(', ')} VU) — no scaling breakdown, latency blowup, or shape divergence detected.`,
    });
  }
  return out;
}

function analyzeUrlCompare(runs: RunSummary[]): Finding[] {
  const out: Finding[] = [];

  const byP95 = [...runs].sort((a, b) => b.steadyStateP95 - a.steadyStateP95);
  const slowest = byP95[0]!;
  const fastest = byP95[byP95.length - 1]!;
  if (fastest.steadyStateP95 > 0) {
    const ratio = slowest.steadyStateP95 / fastest.steadyStateP95;
    const severity: Finding['severity'] = ratio >= URL_LATENCY_RATIO ? 'warn' : 'info';
    out.push({
      severity,
      rule: 'url_latency_rank',
      headline: `Slowest target: ${slowest.targetUrl} (p95 ~${Math.round(slowest.steadyStateP95)}ms).`,
      detail: `Fastest ${fastest.targetUrl} at ~${Math.round(fastest.steadyStateP95)}ms — ${ratio.toFixed(1)}× difference under identical load.`,
    });
  }

  const byErr = [...runs].sort((a, b) => b.errorRate - a.errorRate);
  const worstErr = byErr[0]!;
  const minErr = byErr[byErr.length - 1]!.errorRate;
  const errRatio = minErr > 0 ? worstErr.errorRate / minErr : Infinity;
  if (worstErr.errorRate > URL_ERROR_ABSOLUTE || (minErr > 0 && errRatio >= URL_ERROR_RATIO)) {
    out.push({
      severity: 'warn',
      rule: 'url_error_rank',
      headline: `${worstErr.targetUrl} errors at ${(worstErr.errorRate * 100).toFixed(2)}%.`,
      detail: minErr > 0 && Number.isFinite(errRatio)
        ? `That's ${errRatio.toFixed(1)}× the next-worst target.`
        : `Other targets under identical load errored below ${URL_ERROR_ABSOLUTE * 100}%.`,
    });
  }

  const byRps = [...runs].sort((a, b) => b.steadyStateRps - a.steadyStateRps);
  const bestRps = byRps[0]!;
  const worstRps = byRps[byRps.length - 1]!;
  if (bestRps.steadyStateRps > 0 && worstRps.steadyStateRps / bestRps.steadyStateRps <= URL_RPS_FLOOR) {
    out.push({
      severity: 'warn',
      rule: 'url_throughput_rank',
      headline: `${worstRps.targetUrl} sustained only ${worstRps.steadyStateRps.toFixed(1)} rps.`,
      detail: `${bestRps.targetUrl} sustained ${bestRps.steadyStateRps.toFixed(1)} rps under the same load.`,
    });
  }

  if (out.length === 0 || out.every((f) => f.severity === 'info' || f.severity === 'ok')) {
    out.push({
      severity: 'ok',
      rule: 'url_compare_healthy',
      headline: 'All targets performed comparably under identical load.',
      detail: `${runs.length} targets: p95 spread ${Math.round(fastest.steadyStateP95)}–${Math.round(slowest.steadyStateP95)}ms, no error or throughput outliers.`,
    });
  }
  return out;
}

function steadyStateRows(metrics: PerSecondMetric[], rampUpMs: number): PerSecondMetric[] {
  if (metrics.length === 0) return [];
  const seconds = [...new Set(metrics.map((m) => m.second))].sort((a, b) => a - b);
  if (seconds.length <= 2) return [];
  const firstSecond = seconds[0]!;
  const rampSeconds = Math.ceil(rampUpMs / 1000);
  const steadyStart = firstSecond + rampSeconds;
  const lastKept = seconds[seconds.length - 1 - 2]!;
  return metrics.filter((m) => m.second >= steadyStart && m.second <= lastKept);
}

function meanOf(v: number[]): number {
  if (v.length === 0) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
