-- 003 used countIf(status_code >= 400), which misses status_code = 0.
-- Generators record status_code = 0 for engine-level failures (network errors,
-- extract/interpolation errors). The cold path needs to match the hot path's
-- error accounting, so include status 0 in error_count.
DROP VIEW IF EXISTS load_metrics_1s_mv;

CREATE MATERIALIZED VIEW load_metrics_1s_mv TO load_metrics_1s AS
SELECT
  test_id,
  step_name,
  toStartOfSecond(timestamp)                     AS second,
  quantileExactState(0.50)(latency_ms)           AS latency_p50,
  quantileExactState(0.95)(latency_ms)           AS latency_p95,
  quantileExactState(0.99)(latency_ms)           AS latency_p99,
  count()                                        AS request_count,
  countIf(status_code = 0 OR status_code >= 400) AS error_count,
  sum(response_bytes)                            AS bytes_sum
FROM load_events
GROUP BY test_id, step_name, second;
