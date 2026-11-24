-- 0003_rate_limits: fixed-window counters shared by all serverless instances.
CREATE TABLE rate_limits (
  bucket        text NOT NULL,
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL,
  PRIMARY KEY (bucket, key, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
