-- 0005_traces_observability: per-span cached tokens and channel for the observability drawer.
ALTER TABLE traces
  ADD COLUMN tokens_cached integer,
  ADD COLUMN channel text NOT NULL DEFAULT 'chat' CHECK (channel IN ('chat', 'voice'));
CREATE INDEX traces_session_started_idx ON traces (session_id, started_at);
