// Thin REST client for the controller. The dashboard's dev server proxies
// /api/* to the controller via next.config.mjs rewrites, so paths are
// origin-relative everywhere. In prod the same origin fronts both.

import type { Finding, PerSecondMetric, Scenario, TestStatus, TestSummary } from '@hammr/shared';

export interface TestListItem {
  id: string;
  name: string;
  status: TestStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

export interface TestDetail {
  id: string;
  name: string;
  status: TestStatus;
  config: Scenario;
  summary: (TestSummary & { droppedEvents?: number }) | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}

export interface ListResponse {
  tests: TestListItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface MetricsResponse {
  testId: string;
  status: TestStatus;
  metrics: PerSecondMetric[];
}

export interface AnalysisResponse {
  testId: string;
  findings: Finding[];
}

export type RunShape = 'healthy' | 'spike-recover' | 'monotonic-climb' | 'elevated-plateau';

export interface CompareRunSummary {
  testId: string;
  vus: number;
  targetUrl: string;
  steadyStateP95: number;
  steadyStateRps: number;
  errorRate: number;
  shape: RunShape;
  findings: Finding[];
}

export interface CompareRun {
  testId: string;
  name: string;
  config: Scenario;
  metrics: PerSecondMetric[];
  summary: CompareRunSummary;
}

export interface CompareResponse {
  dimension: 'vu_count' | 'target_url';
  runs: CompareRun[];
  comparison: Finding[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const api = {
  listTests: (limit = 50, offset = 0) =>
    request<ListResponse>(`/api/tests?limit=${limit}&offset=${offset}`),
  getTest: (id: string) => request<TestDetail>(`/api/tests/${id}`),
  getMetrics: (id: string) => request<MetricsResponse>(`/api/tests/${id}/metrics`),
  getAnalysis: (id: string) => request<AnalysisResponse>(`/api/tests/${id}/analysis`),
  createTest: (scenario: Scenario) =>
    request<{ testId: string; status: string }>('/api/tests', {
      method: 'POST',
      body: JSON.stringify(scenario),
    }),
  stopTest: (id: string) =>
    request<{ testId: string; status: string }>(`/api/tests/${id}`, { method: 'DELETE' }),
  compareTests: (ids: string[]) =>
    request<CompareResponse>(`/api/compare?ids=${ids.map(encodeURIComponent).join(',')}`),
};
