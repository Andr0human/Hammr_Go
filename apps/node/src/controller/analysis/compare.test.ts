import test from 'node:test';
import assert from 'node:assert/strict';
import type { PerSecondMetric, Scenario } from '@hammr/shared';
import { detectDimension } from '@hammr/shared';
import { buildRunSummary, classifyShape, compareRuns, type RunSummary } from './compare.js';

function baseScenario(over: Partial<Scenario> = {}): Scenario {
  return {
    name: 'JobNest login',
    baseUrl: 'https://jobnest.example.com',
    config: { users: 50, rampUp: '5s', duration: '30s' },
    scenario: [{ name: 'Login', method: 'POST', path: '/login' }],
    ...over,
  };
}

function flatMetrics(seconds: number, p95: number, rps: number, errorRate = 0): PerSecondMetric[] {
  const out: PerSecondMetric[] = [];
  for (let i = 0; i < seconds; i++) {
    out.push({ second: i, stepName: 'Login', p50: p95 / 2, p95, p99: p95 * 1.2, rps, errorRate, bytesPerSec: 1000 });
  }
  return out;
}

function summary(over: Partial<RunSummary>): RunSummary {
  const base: RunSummary = {
    testId: 't',
    vus: 50,
    targetUrl: 'https://a.example',
    steadyStateP95: 300,
    steadyStateP99: 360,
    steadyStateRps: 50,
    errorRate: 0,
    shape: 'healthy',
    findings: [],
  };
  const merged = { ...base, ...over };
  // If caller overrode p95 but not p99, keep p99 proportional so tail-divergence
  // doesn't fire incidentally in tests targeting other rules.
  if (over.steadyStateP95 !== undefined && over.steadyStateP99 === undefined) {
    merged.steadyStateP99 = over.steadyStateP95 * 1.2;
  }
  return merged;
}

test('detectDimension accepts VU-only selection', () => {
  const r = detectDimension([baseScenario({ config: { users: 50, rampUp: '5s', duration: '30s' } }), baseScenario({ config: { users: 100, rampUp: '5s', duration: '30s' } })]);
  assert.deepEqual(r, { ok: true, dimension: 'vu_count' });
});

test('detectDimension accepts URL-only selection', () => {
  const r = detectDimension([baseScenario({ baseUrl: 'https://a.example' }), baseScenario({ baseUrl: 'https://b.example' })]);
  assert.deepEqual(r, { ok: true, dimension: 'target_url' });
});

test('detectDimension rejects when both VU and URL differ', () => {
  const r = detectDimension([
    baseScenario({ baseUrl: 'https://a.example', config: { users: 50, rampUp: '5s', duration: '30s' } }),
    baseScenario({ baseUrl: 'https://b.example', config: { users: 100, rampUp: '5s', duration: '30s' } }),
  ]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, 'incomparable_selection');
    assert.deepEqual(r.differingFields?.sort(), ['baseUrl', 'config.users']);
  }
});

test('detectDimension rejects when scenario steps differ', () => {
  const r = detectDimension([
    baseScenario({ scenario: [{ name: 'A', method: 'GET', path: '/a' }], config: { users: 50, rampUp: '5s', duration: '30s' } }),
    baseScenario({ scenario: [{ name: 'B', method: 'GET', path: '/b' }], config: { users: 100, rampUp: '5s', duration: '30s' } }),
  ]);
  assert.equal(r.ok, false);
});

test('detectDimension rejects duplicate VU values', () => {
  const r = detectDimension([baseScenario(), baseScenario()]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'no_varying_dimension');
});

test('detectDimension rejects fewer than 2 runs', () => {
  const r = detectDimension([baseScenario()]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'too_few_runs');
});

test('detectDimension rejects more than 10 runs', () => {
  const runs = Array.from({ length: 11 }, (_, i) => baseScenario({ config: { users: 10 + i, rampUp: '5s', duration: '30s' } }));
  const r = detectDimension(runs);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'too_many_runs');
});

test('classifyShape maps rules to shape ordinals', () => {
  assert.equal(classifyShape([{ severity: 'warn', rule: 'saturation', headline: '', detail: '' }]), 'monotonic-climb');
  assert.equal(classifyShape([{ severity: 'warn', rule: 'latency_elevation', headline: '', detail: '' }]), 'elevated-plateau');
  assert.equal(classifyShape([{ severity: 'warn', rule: 'error_spike', headline: '', detail: '' }]), 'spike-recover');
  assert.equal(classifyShape([]), 'healthy');
});

test('buildRunSummary computes steady-state stats from metrics', () => {
  const sum = buildRunSummary({
    testId: 'x',
    vus: 50,
    targetUrl: 'https://a.example',
    metrics: flatMetrics(20, 400, 50),
    rampUpMs: 2000,
  });
  assert.ok(sum.steadyStateP95 > 390 && sum.steadyStateP95 < 410);
  assert.ok(sum.steadyStateP99 > 470 && sum.steadyStateP99 < 490);
  assert.ok(sum.steadyStateRps > 45 && sum.steadyStateRps < 55);
  assert.equal(sum.errorRate, 0);
});

test('VU sweep: scaling_efficiency_drift fires info when RPS/VU drops 15-30%', () => {
  // 20→50 VU: 2.5x load, 2.075x rps → eff 0.83 (between 0.70 floor and 0.85 drift)
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 250, steadyStateRps: 37 }),
    summary({ testId: 'b', vus: 20, steadyStateP95: 262, steadyStateRps: 72 }),
    summary({ testId: 'c', vus: 50, steadyStateP95: 370, steadyStateRps: 150 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const drift = findings.find((f) => f.rule === 'scaling_efficiency_drift');
  assert.ok(drift, 'expected scaling_efficiency_drift finding');
  assert.equal(drift!.severity, 'info');
  // Hard scaling_efficiency must NOT fire (eff > 0.7 everywhere here)
  assert.equal(findings.find((f) => f.rule === 'scaling_efficiency'), undefined);
});

test('VU sweep: scaling_efficiency_drift suppressed when hard scaling_efficiency fires', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, steadyStateP95: 200, steadyStateRps: 50 }),
    summary({ testId: 'b', vus: 100, steadyStateP95: 220, steadyStateRps: 60 }), // eff 0.6
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.ok(findings.some((f) => f.rule === 'scaling_efficiency'));
  assert.equal(findings.find((f) => f.rule === 'scaling_efficiency_drift'), undefined);
});

test('VU sweep: tail_divergence fires info when p99 grows >=1.5x faster than p95', () => {
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 250, steadyStateP99: 400, steadyStateRps: 37 }),
    // p95 ratio 1.04, p99 ratio 1.75 — p99 grew far faster than p95
    summary({ testId: 'b', vus: 20, steadyStateP95: 260, steadyStateP99: 700, steadyStateRps: 74 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const tail = findings.find((f) => f.rule === 'tail_divergence');
  assert.ok(tail, 'expected tail_divergence finding');
  assert.equal(tail!.severity, 'info');
});

test('VU sweep: scaling_efficiency_drift batches all drift pairs into one finding', () => {
  // 10→20: eff 0.96 (no drift). 20→50: eff 0.83 (drift). 50→60: eff 1.10
  // (no drift, super-linear noise). 60→80: eff 0.84 (drift).
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 250, steadyStateRps: 37 }),
    summary({ testId: 'b', vus: 20, steadyStateP95: 262, steadyStateRps: 72 }),
    summary({ testId: 'c', vus: 50, steadyStateP95: 370, steadyStateRps: 150 }),
    summary({ testId: 'd', vus: 60, steadyStateP95: 266, steadyStateRps: 198 }),
    summary({ testId: 'e', vus: 80, steadyStateP95: 457, steadyStateRps: 222 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const drifts = findings.filter((f) => f.rule === 'scaling_efficiency_drift');
  assert.equal(drifts.length, 1, 'expect one batched drift finding, not per-pair');
  assert.match(drifts[0]!.detail, /20→50 VU/);
  assert.match(drifts[0]!.detail, /60→80 VU/);
});

test('VU sweep: scaling_efficiency_overall fires when end-to-end eff < 0.85', () => {
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 250, steadyStateRps: 37 }),
    summary({ testId: 'b', vus: 20, steadyStateP95: 262, steadyStateRps: 72 }),
    summary({ testId: 'c', vus: 80, steadyStateP95: 457, steadyStateRps: 222 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const overall = findings.find((f) => f.rule === 'scaling_efficiency_overall');
  assert.ok(overall, 'expected scaling_efficiency_overall');
  assert.equal(overall!.severity, 'info');
  // 8x load, 222/37 ≈ 6.0x throughput → eff ≈ 0.75
  assert.match(overall!.headline, /10 to 80 VUs/);
});

test('VU sweep: scaling_efficiency_overall stays silent for 2-run comparisons', () => {
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateRps: 37 }),
    summary({ testId: 'b', vus: 80, steadyStateRps: 200 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.equal(findings.find((f) => f.rule === 'scaling_efficiency_overall'), undefined);
});

test('VU sweep: shape_degradation warns when shape worsens (no shape_divergence)', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, shape: 'monotonic-climb', steadyStateP95: 370, steadyStateRps: 150 }),
    summary({ testId: 'b', vus: 80, shape: 'elevated-plateau', steadyStateP95: 457, steadyStateRps: 222 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const deg = findings.find((f) => f.rule === 'shape_degradation');
  assert.ok(deg, 'expected shape_degradation finding');
  assert.equal(deg!.severity, 'warn');
});

test('VU sweep: shape_degradation suppressed when shape_divergence fires', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, shape: 'healthy', steadyStateP95: 200, steadyStateRps: 50 }),
    summary({ testId: 'b', vus: 200, shape: 'monotonic-climb', steadyStateP95: 220, steadyStateRps: 200 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.ok(findings.some((f) => f.rule === 'shape_divergence'));
  assert.equal(findings.find((f) => f.rule === 'shape_degradation'), undefined);
});

test('VU sweep: tail_divergence stays silent when p99 tracks p95', () => {
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 250, steadyStateP99: 300, steadyStateRps: 37 }),
    summary({ testId: 'b', vus: 20, steadyStateP95: 500, steadyStateP99: 600, steadyStateRps: 74 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.equal(findings.find((f) => f.rule === 'tail_divergence'), undefined);
});

test('VU sweep: latency blowup fires when p95 doubles under <=2x load', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, steadyStateP95: 500, steadyStateRps: 50 }),
    summary({ testId: 'b', vus: 100, steadyStateP95: 2000, steadyStateRps: 60 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.ok(findings.some((f) => f.rule === 'latency_blowup'));
  assert.ok(findings.some((f) => f.rule === 'scaling_efficiency'));
});

test('VU sweep: error_escalation fires critical when a rung exceeds 5% error', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, steadyStateP95: 500, steadyStateRps: 50, errorRate: 0 }),
    summary({ testId: 'b', vus: 200, steadyStateP95: 600, steadyStateRps: 100, errorRate: 0.08 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const err = findings.find((f) => f.rule === 'error_escalation');
  assert.ok(err);
  assert.equal(err!.severity, 'critical');
});

test('VU sweep: error_escalation fires warn at 1-5% and stays silent below 1%', () => {
  const warnRuns = [
    summary({ testId: 'a', vus: 50, errorRate: 0 }),
    summary({ testId: 'b', vus: 100, errorRate: 0.02 }),
  ];
  assert.ok(compareRuns(warnRuns, 'vu_count').find((f) => f.rule === 'error_escalation' && f.severity === 'warn'));

  const silentRuns = [
    summary({ testId: 'a', vus: 50, errorRate: 0 }),
    summary({ testId: 'b', vus: 100, errorRate: 0.005 }),
  ];
  assert.equal(compareRuns(silentRuns, 'vu_count').find((f) => f.rule === 'error_escalation'), undefined);
});

test('VU sweep: healthy finding when all rungs scale cleanly', () => {
  const runs = [
    summary({ testId: 'a', vus: 10, steadyStateP95: 100, steadyStateRps: 10 }),
    summary({ testId: 'b', vus: 20, steadyStateP95: 110, steadyStateRps: 20 }),
    summary({ testId: 'c', vus: 40, steadyStateP95: 115, steadyStateRps: 40 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, 'vu_sweep_healthy');
});

test('VU sweep: shape divergence escalates to critical', () => {
  const runs = [
    summary({ testId: 'a', vus: 50, shape: 'healthy', steadyStateP95: 200, steadyStateRps: 50 }),
    summary({ testId: 'b', vus: 200, shape: 'monotonic-climb', steadyStateP95: 220, steadyStateRps: 200 }),
  ];
  const findings = compareRuns(runs, 'vu_count');
  const shape = findings.find((f) => f.rule === 'shape_divergence');
  assert.ok(shape);
  assert.equal(shape!.severity, 'critical');
});

test('URL compare: latency-rank warns when one target is 2x slower', () => {
  const runs = [
    summary({ testId: 'a', targetUrl: 'https://fast', steadyStateP95: 100, steadyStateRps: 50 }),
    summary({ testId: 'b', targetUrl: 'https://slow', steadyStateP95: 300, steadyStateRps: 50 }),
  ];
  const findings = compareRuns(runs, 'target_url');
  const rank = findings.find((f) => f.rule === 'url_latency_rank');
  assert.ok(rank);
  assert.equal(rank!.severity, 'warn');
});

test('URL compare: healthy when targets are comparable', () => {
  const runs = [
    summary({ testId: 'a', targetUrl: 'https://x', steadyStateP95: 100, steadyStateRps: 50 }),
    summary({ testId: 'b', targetUrl: 'https://y', steadyStateP95: 110, steadyStateRps: 48 }),
  ];
  const findings = compareRuns(runs, 'target_url');
  assert.ok(findings.some((f) => f.rule === 'url_compare_healthy'));
});
