import "server-only";
import { db } from "@/lib/db/client";
import { redact } from "@/lib/observability/redact";
import type { Trace } from "@/lib/observability/trace";
import type { Channel, SpanKind } from "@/lib/types";

/** Writes every span of a turn (redacted) to `traces` in one transaction. */
export async function persistTrace(sessionId: string, trace: Trace, channel: Channel): Promise<void> {
  if (!trace.spans.length) return;
  await db().transaction((tx) =>
    trace.spans.map(
      (s) => tx`
        INSERT INTO traces (id, session_id, turn_id, parent_id, kind, name, status, started_at, duration_ms,
                            input, output, tokens_in, tokens_out, tokens_cached, cost_usd, error, channel)
        VALUES (${s.id}, ${sessionId}, ${s.turnId}, ${s.parentId ?? null}, ${s.kind}, ${s.name}, ${s.status}, ${s.startedAt},
                ${s.durationMs}, ${JSON.stringify(redact(s.input ?? null))}::jsonb, ${JSON.stringify(redact(s.output ?? null))}::jsonb,
                ${s.tokensIn ?? null}, ${s.tokensOut ?? null}, ${s.tokensCached ?? null}, ${s.costUsd ?? null},
                ${s.error ? redact(s.error) : null}, ${channel})
        ON CONFLICT (id) DO NOTHING`,
    ),
  );
}

export interface TraceRow {
  id: string;
  turn_id: string;
  parent_id: string | null;
  kind: SpanKind;
  name: string;
  status: "ok" | "error";
  started_at: string;
  duration_ms: number;
  input: unknown;
  output: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  cost_usd: string | number | null;
  error: string | null;
  channel: Channel;
}

export async function loadTraceRows(sessionId: string): Promise<TraceRow[]> {
  return (await db()`
    SELECT id, turn_id, parent_id, kind, name, status, started_at, duration_ms, input, output,
           tokens_in, tokens_out, tokens_cached, cost_usd, error, channel
    FROM traces WHERE session_id = ${sessionId} ORDER BY started_at, id`) as TraceRow[];
}
