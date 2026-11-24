-- 0004_agent: append-only session event log, actions ledger (write-ahead), escalation tickets.

-- Replaced by session_events (one ordered log per session, shared by chat and voice).
DROP TABLE messages;

CREATE TABLE session_events (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL CHECK (type IN ('user_message', 'assistant_message', 'tool_call', 'tool_result', 'escalation', 'error')),
  channel     text NOT NULL CHECK (channel IN ('chat', 'voice')),
  turn_id     uuid NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

-- Append-only: no updates or deletes through the app.
CREATE FUNCTION session_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session_events is append-only';
END;
$$;
CREATE TRIGGER session_events_no_update BEFORE UPDATE OR DELETE ON session_events
  FOR EACH ROW EXECUTE FUNCTION session_events_append_only();

-- Every account action is written here BEFORE success is acknowledged.
CREATE TABLE actions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text NOT NULL UNIQUE,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  customer_id      text NOT NULL,
  action_type      text NOT NULL CHECK (action_type IN ('refund')),
  status           text NOT NULL CHECK (status IN ('pending', 'succeeded', 'rejected')),
  invoice_id       text,
  amount_usd       numeric(12, 2),
  request          jsonb NOT NULL,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
CREATE INDEX actions_customer_invoice_idx ON actions (customer_id, invoice_id) WHERE status = 'succeeded';

CREATE SEQUENCE ticket_number_seq START 1001;

CREATE TABLE tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number    text NOT NULL UNIQUE DEFAULT 'ESC-' || nextval('ticket_number_seq'),
  idempotency_key  text NOT NULL UNIQUE,
  session_id       uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  customer_id      text,
  tier             text,
  contract_status  text,
  reason           text NOT NULL,
  priority         text NOT NULL CHECK (priority IN ('P1', 'P2', 'P3')),
  summary          text NOT NULL,
  status           text NOT NULL DEFAULT 'open',
  created_at       timestamptz NOT NULL DEFAULT now()
);
