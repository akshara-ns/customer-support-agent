-- 0001_init: sessions, messages, traces, documents/chunks with pgvector embeddings.

CREATE EXTENSION IF NOT EXISTS vector;

-- One conversation, shared by chat and voice.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   text,
  verified      boolean NOT NULL DEFAULT false,
  agent_state   text NOT NULL DEFAULT 'idle',
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  channel       text NOT NULL CHECK (channel IN ('chat', 'voice')),
  content       text NOT NULL,
  tool_name     text,
  tool_call_id  text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_session_created_idx ON messages (session_id, created_at);

-- One row per span (llm call, tool call, retrieval, guardrail) within a turn.
CREATE TABLE traces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id       uuid NOT NULL,
  parent_id     uuid,
  kind          text NOT NULL CHECK (kind IN ('agent', 'llm', 'tool', 'retrieval', 'guardrail')),
  name          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok', 'error')),
  started_at    timestamptz NOT NULL,
  duration_ms   integer NOT NULL,
  input         jsonb,
  output        jsonb,
  tokens_in     integer,
  tokens_out    integer,
  cost_usd      numeric(12, 6),
  error         text
);
CREATE INDEX traces_session_turn_idx ON traces (session_id, turn_id, started_at);

-- Source policy documents. `tiers` lists which subscription tiers may see the doc.
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  title         text NOT NULL,
  category      text NOT NULL,
  tiers         text[] NOT NULL,
  content_hash  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   integer NOT NULL,
  heading       text,
  content       text NOT NULL,
  token_count   integer NOT NULL,
  tiers         text[] NOT NULL,
  embedding     vector(1536) NOT NULL,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tiers_gin_idx ON chunks USING gin (tiers);
