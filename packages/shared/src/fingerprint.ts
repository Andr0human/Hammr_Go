import type { Scenario } from './scenario.js';

export type ComparisonDimension = 'vu_count' | 'target_url';

export type DimensionResult =
  | { ok: true; dimension: ComparisonDimension }
  | {
      ok: false;
      reason:
        | 'too_few_runs'
        | 'too_many_runs'
        | 'incomparable_selection'
        | 'no_varying_dimension';
      differingFields?: string[];
    };

export const COMPARE_MIN_RUNS = 2;
export const COMPARE_MAX_RUNS = 10;

// The six fields we fingerprint on. Step order is meaningful so the whole
// `scenario` array is compared as one unit. `name` is intentionally excluded:
// it's a user label, and `baseUrl` + `scenario` are the real semantic guards
// against comparing unrelated experiments.
const FIELDS = ['baseUrl', 'config.users', 'config.rampUp', 'config.duration', 'config.thinkTime', 'scenario'] as const;
type Field = (typeof FIELDS)[number];

function getField(s: Scenario, f: Field): unknown {
  switch (f) {
    case 'baseUrl': return s.baseUrl;
    case 'config.users': return s.config.users;
    case 'config.rampUp': return s.config.rampUp;
    case 'config.duration': return s.config.duration;
    case 'config.thinkTime': return s.config.thinkTime;
    case 'scenario': return s.scenario;
  }
}

// Stable stringify — keys sorted recursively so object field order doesn't
// affect equality. `undefined` and missing keys canonicalise identically
// (treated as absent), which matches how the zod parser normalises input.
export function canonical(v: unknown): string {
  if (v === undefined) return '_u';
  if (v === null) return 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, val]) => JSON.stringify(k) + ':' + canonical(val)).join(',') + '}';
}

// Which of the tracked fields differ across the given scenarios? Compares
// each scenario against scenarios[0] — returns the union of differing fields
// so callers see every dimension that's varying, not just the first.
export function differingFields(scenarios: Scenario[]): Field[] {
  if (scenarios.length < 2) return [];
  const base = scenarios[0]!;
  const diff = new Set<Field>();
  for (let i = 1; i < scenarios.length; i++) {
    const s = scenarios[i]!;
    for (const f of FIELDS) {
      if (canonical(getField(base, f)) !== canonical(getField(s, f))) {
        diff.add(f);
      }
    }
  }
  return FIELDS.filter((f) => diff.has(f));
}

const DIMENSION_FIELD: Record<ComparisonDimension, Field> = {
  vu_count: 'config.users',
  target_url: 'baseUrl',
};

export function detectDimension(scenarios: Scenario[]): DimensionResult {
  if (scenarios.length < COMPARE_MIN_RUNS) return { ok: false, reason: 'too_few_runs' };
  if (scenarios.length > COMPARE_MAX_RUNS) return { ok: false, reason: 'too_many_runs' };

  const differing = differingFields(scenarios);
  if (differing.length === 0) return { ok: false, reason: 'no_varying_dimension' };

  if (differing.length === 1) {
    const only = differing[0]!;
    for (const dim of ['vu_count', 'target_url'] as const) {
      if (DIMENSION_FIELD[dim] === only && allDistinct(scenarios, dim)) {
        return { ok: true, dimension: dim };
      }
    }
  }

  return { ok: false, reason: 'incomparable_selection', differingFields: differing };
}

function allDistinct(scenarios: Scenario[], dim: ComparisonDimension): boolean {
  const seen = new Set<string>();
  for (const s of scenarios) {
    const key = canonical(getField(s, DIMENSION_FIELD[dim]));
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
