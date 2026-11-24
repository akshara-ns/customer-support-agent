-- 0006_stream_events: numbered SSE events per chat stream, so a dropped client can resume
-- (serverless instances share no memory; the resume request may land on another instance).
CREATE TABLE stream_events (
  stream_id   uuid NOT NULL,
  seq         integer NOT NULL,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type        text NOT NULL,
  event       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stream_id, seq)
);
CREATE INDEX stream_events_created_idx ON stream_events (created_at);
