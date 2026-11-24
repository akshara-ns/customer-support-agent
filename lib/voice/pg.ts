import "server-only";
import { db } from "@/lib/db/client";
import { redact } from "@/lib/observability/redact";
import type { TraceWriter } from "@/lib/voice/bridge";

/** Voice rows in the `traces` table: realtime usage per response and spoken claim-check flags. */
export const pgTraceWriter: TraceWriter = {
  async write(r) {
    await db()`
      INSERT INTO traces (session_id, turn_id, kind, name, status, started_at, duration_ms, output, tokens_in, tokens_out, tokens_cached, cost_usd, channel)
      VALUES (${r.sessionId}, ${r.turnId}, ${r.kind}, ${r.name}, 'ok', now(), 0, ${JSON.stringify(redact(r.output))}::jsonb,
              ${r.tokensIn}, ${r.tokensOut}, ${r.tokensCached}, ${r.costUsd}, 'voice')`;
  },
};
