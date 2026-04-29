export type TestStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface PerSecondMetric {
  second: number;
  stepName: string;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  errorRate: number;
  bytesPerSec: number;
}

export interface TestSummary {
  totalEvents: number;
  errors: number;
  durationMs: number;
}

export type FindingSeverity = 'ok' | 'info' | 'warn' | 'critical';

export interface Finding {
  severity: FindingSeverity;
  headline: string;
  detail: string;
  rule: string;
}
