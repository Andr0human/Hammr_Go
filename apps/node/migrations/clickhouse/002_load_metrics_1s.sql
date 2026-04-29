CREATE TABLE IF NOT EXISTS load_metrics_1s (
  test_id        String,
  step_name      LowCardinality(String),
  second         DateTime,
  latency_p50    AggregateFunction(quantileExact(0.50), UInt32),
  latency_p95    AggregateFunction(quantileExact(0.95), UInt32),
  latency_p99    AggregateFunction(quantileExact(0.99), UInt32),
  request_count  SimpleAggregateFunction(sum, UInt64),
  error_count    SimpleAggregateFunction(sum, UInt64),
  bytes_sum      SimpleAggregateFunction(sum, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (test_id, step_name, second);
