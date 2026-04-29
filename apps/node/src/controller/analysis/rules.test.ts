import test from 'node:test';
import assert from 'node:assert/strict';
import type { PerSecondMetric } from '@hammr/shared';
import { analyze } from './rules.js';

function m(over: Partial<PerSecondMetric>): PerSecondMetric {
  return {
    second: 0,
    stepName: 'Login',
    p50: 40,
    p95: 60,
    p99: 80,
    rps: 10,
    errorRate: 0,
    bytesPerSec: 1000,
    ...over,
  };
}

// Build a healthy baseline run with `n` steady-state seconds + 1 tail second.
function healthyRun(n: number, opts: Partial<PerSecondMetric> = {}): PerSecondMetric[] {
  const out: PerSecondMetric[] = [];
  for (let i = 0; i < n + 1; i++) out.push(m({ second: i, ...opts }));
  return out;
}

test('healthy-run fallback fires when no other rule matches', () => {
  const findings = analyze(healthyRun(20), { rampUpMs: 0 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'healthy_fallback');
  assert.equal(findings[0]!.severity, 'ok');
});

test('saturation rule fires on flat RPS with rising p95', () => {
  const metrics: PerSecondMetric[] = [];
  for (let i = 0; i < 20; i++) {
    metrics.push(m({ second: i, p95: 100 + i * 10, rps: 50 }));
  }
  // shutdown tail
  metrics.push(m({ second: 20, p95: 5000, rps: 5 }));

  const findings = analyze(metrics, { rampUpMs: 0 });
  assert.ok(findings.some((f) => f.rule === 'saturation' && f.severity === 'warn'));
});

test('error-spike warn fires for >1% and critical for >5%', () => {
  const warnRun: PerSecondMetric[] = [];
  for (let i = 0; i < 12; i++) {
    warnRun.push(m({ second: i, errorRate: i === 5 ? 0.02 : 0 }));
  }
  const warnFindings = analyze(warnRun, { rampUpMs: 0 });
  const warnHit = warnFindings.find((f) => f.rule === 'error_spike');
  assert.ok(warnHit);
  assert.equal(warnHit!.severity, 'warn');

  const critRun: PerSecondMetric[] = [];
  for (let i = 0; i < 12; i++) {
    critRun.push(m({ second: i, errorRate: i === 5 ? 0.2 : 0 }));
  }
  const critFindings = analyze(critRun, { rampUpMs: 0 });
  const critHit = critFindings.find((f) => f.rule === 'error_spike');
  assert.ok(critHit);
  assert.equal(critHit!.severity, 'critical');
});

test('error spikes in the shutdown tail are ignored', () => {
  const metrics: PerSecondMetric[] = healthyRun(10);
  // Overwrite the last (tail) second with spiky data.
  metrics[metrics.length - 1] = m({ second: 10, errorRate: 0.5 });
  const findings = analyze(metrics, { rampUpMs: 0 });
  assert.ok(!findings.some((f) => f.rule === 'error_spike'));
});

test('step imbalance fires on 2× p95 gap between steps', () => {
  const metrics: PerSecondMetric[] = [];
  for (let i = 0; i < 12; i++) {
    metrics.push(m({ second: i, stepName: 'Fast', p95: 50 }));
    metrics.push(m({ second: i, stepName: 'Slow', p95: 200 }));
  }
  const findings = analyze(metrics, { rampUpMs: 0 });
  const hit = findings.find((f) => f.rule === 'step_imbalance');
  assert.ok(hit);
  assert.match(hit!.headline, /Slow/);
});

test('saturation rule ignores a transient 1–2s late spike', () => {
  // 19 flat buckets at ~880ms p95, then 2 late spikes — the ayushsinha.dev
  // 50-VU false positive. OLS slope alone would drag above threshold; the
  // median-of-thirds guard should veto.
  const flat = [902, 854, 867, 865, 918, 836, 969, 942, 900, 882, 977, 887, 917, 945, 1079, 821, 902, 863, 847];
  const spike = [1348, 2056];
  const metrics: PerSecondMetric[] = [];
  const p95s = [...flat, ...spike];
  for (let i = 0; i < p95s.length; i++) metrics.push(m({ second: i, p95: p95s[i]!, rps: 28 }));
  // tail
  metrics.push(m({ second: p95s.length, p95: 819, rps: 24 }));
  const findings = analyze(metrics, { rampUpMs: 0 });
  assert.ok(!findings.some((f) => f.rule === 'saturation'), 'saturation must not fire on transient tail');
});

test('latency-elevation fires when steady plateau sits well above opening', () => {
  // ayushsinha.dev 100-VU shape: climb during ramp, then plateau at ~3× baseline.
  const metrics: PerSecondMetric[] = [];
  // ramp / opening load — low p95
  metrics.push(m({ second: 0, p95: 867, rps: 15 }));
  metrics.push(m({ second: 1, p95: 905, rps: 19 }));
  // climb
  metrics.push(m({ second: 2, p95: 1033, rps: 32 }));
  metrics.push(m({ second: 3, p95: 1207, rps: 31 }));
  metrics.push(m({ second: 4, p95: 1435, rps: 35 }));
  // plateau ~2600ms
  const plateau = [2568, 2578, 2799, 2791, 2540, 2492, 2821, 2965, 2499, 2503, 2793, 3043, 2582, 2348, 2329, 2608];
  for (let i = 0; i < plateau.length; i++) {
    metrics.push(m({ second: 5 + i, p95: plateau[i]!, rps: 34 }));
  }
  // tail
  metrics.push(m({ second: 100, p95: 2804, rps: 43 }));

  const findings = analyze(metrics, { rampUpMs: 5000 });
  const hit = findings.find((f) => f.rule === 'latency_elevation');
  assert.ok(hit, 'latency_elevation must fire on elevated plateau');
  assert.ok(hit!.severity === 'warn' || hit!.severity === 'critical');
  assert.ok(!findings.some((f) => f.rule === 'healthy_fallback'), 'healthy_fallback must not also fire');
});

test('jitter rule fires on bimodal p95 with no trend (Opslyft shape)', () => {
  // Steady p95 swings 1200↔3000+ bucket-to-bucket, no drift, no plateau,
  // no elevation vs opening — the Opslyft false-negative.
  const p95s = [1253, 3172, 1250, 2193, 1937, 3272, 3089, 2212, 2893, 1234, 1302, 1241, 4925, 1246, 3200, 1276, 1219, 1219, 3162, 3159, 1232, 1263];
  const metrics: PerSecondMetric[] = [];
  metrics.push(m({ second: 0, p95: 1485, rps: 4 }));
  metrics.push(m({ second: 1, p95: 1260, rps: 4 }));
  for (let i = 0; i < p95s.length; i++) {
    metrics.push(m({ second: 2 + i, p95: p95s[i]!, rps: 8 }));
  }
  metrics.push(m({ second: 100, p95: 1230, rps: 4 }));
  const findings = analyze(metrics, { rampUpMs: 0 });
  assert.ok(findings.some((f) => f.rule === 'jitter' && f.severity === 'warn'));
  assert.ok(!findings.some((f) => f.rule === 'healthy_fallback'));
});

test('jitter rule does not fire on flat healthy run', () => {
  const findings = analyze(healthyRun(20), { rampUpMs: 0 });
  assert.ok(!findings.some((f) => f.rule === 'jitter'));
});

test('ramp-up window is excluded from steady-state rules', () => {
  // p95 blows up only during ramp; steady is flat — no saturation finding.
  const metrics: PerSecondMetric[] = [];
  for (let i = 0; i < 5; i++) metrics.push(m({ second: i, p95: 500 + i * 100, rps: 10 + i * 10 }));
  for (let i = 5; i < 25; i++) metrics.push(m({ second: i, p95: 60, rps: 50 }));
  metrics.push(m({ second: 25, p95: 5000, rps: 5 }));
  const findings = analyze(metrics, { rampUpMs: 5000 });
  assert.ok(!findings.some((f) => f.rule === 'saturation'));
});
