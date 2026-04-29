CREATE MATERIALIZED VIEW IF NOT EXISTS load_metrics_1s_mv TO load_metrics_1s AS
SELECT
  test_id,
  step_name,
  toStartOfSecond(timestamp)               AS second,
  quantileExactState(0.50)(latency_ms)     AS latency_p50,
  quantileExactState(0.95)(latency_ms)     AS latency_p95,
  quantileExactState(0.99)(latency_ms)     AS latency_p99,
  count()                                  AS request_count,
  countIf(status_code >= 400)              AS error_count,
  sum(response_bytes)                      AS bytes_sum
FROM load_events
GROUP BY test_id, step_name, second;
