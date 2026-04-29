import type { ClickHouseClient } from '@clickhouse/client';
import type { PerSecondMetric } from '@hammr/shared';

// The exact query shape from CLAUDE.md. quantileExactMerge over the MV gives us
// per-second p50/p95/p99 identical to what the hot-path aggregator computed
// live. error_rate uses nullIf so we never divide by zero; we coalesce to 0
// client-side because PerSecondMetric.errorRate is typed number.
const METRICS_SQL = `
  SELECT
    toUnixTimestamp(second)                         AS second,
    step_name                                       AS stepName,
    toUInt32(quantileExactMerge(0.50)(latency_p50)) AS p50,
    toUInt32(quantileExactMerge(0.95)(latency_p95)) AS p95,
    toUInt32(quantileExactMerge(0.99)(latency_p99)) AS p99,
    toUInt32(sum(request_count))                    AS rps,
    toFloat64(sum(error_count) / nullIf(sum(request_count), 0)) AS errorRate,
    toUInt64(sum(bytes_sum))                        AS bytesPerSec
  FROM load_metrics_1s
  WHERE test_id = {testId:String}
  GROUP BY second, step_name
  ORDER BY second ASC, step_name ASC
`;

interface MetricRow {
  second: number | string;
  stepName: string;
  p50: number | string;
  p95: number | string;
  p99: number | string;
  rps: number | string;
  errorRate: number | string | null;
  bytesPerSec: number | string;
}

export async function queryTestMetrics(
  ch: ClickHouseClient,
  testId: string,
): Promise<PerSecondMetric[]> {
  const result = await ch.query({
    query: METRICS_SQL,
    query_params: { testId },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as MetricRow[];
  return rows.map((r) => ({
    second: Number(r.second),
    stepName: r.stepName,
    p50: Number(r.p50),
    p95: Number(r.p95),
    p99: Number(r.p99),
    rps: Number(r.rps),
    errorRate: r.errorRate === null ? 0 : Number(r.errorRate),
    bytesPerSec: Number(r.bytesPerSec),
  }));
}
