import "server-only";
import { db } from "@/lib/db/client";
import type { TraceWriter } from "@/lib/voice/bridge";

/** Realtime usage rows in the `traces` table (read later by the observability drawer). */
export const pgTraceWriter: TraceWriter = {
  async write(r) {
    await db()`
      INSERT INTO traces (session_id, turn_id, kind, name, status, started_at, duration_ms, output, tokens_in, tokens_out, cost_usd)
      VALUES (${r.sessionId}, ${r.turnId}, 'llm', ${r.name}, 'ok', now(), 0, ${JSON.stringify(r.output)}::jsonb,
              ${r.tokensIn}, ${r.tokensOut}, ${r.costUsd})`;
  },
};
