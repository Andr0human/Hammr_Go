CREATE TABLE IF NOT EXISTS load_events (
  test_id         String,
  step_name       LowCardinality(String),
  generator_id    LowCardinality(String),
  thread_id       UInt16,
  vu_id           UInt32,
  status_code     UInt16,
  latency_ms      UInt32,
  response_bytes  UInt32,
  timestamp       DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (test_id, step_name, timestamp);
