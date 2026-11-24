import { z } from "zod";
import { PRICING_PER_MTOK, PRICING_SOURCE, REALTIME_PRICING_PER_MTOK } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { loadTraceRows } from "@/lib/observability/pg-traces";
import { buildReport } from "@/lib/observability/report";

/** GET /api/sessions/:id/traces: the observability drawer's data for one session. */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/traces">): Promise<Response> {
  const requestId = newRequestId(request);
  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return errorResponse(400, "invalid_request", "Session id must be a UUID.", requestId);
  try {
    const report = buildReport(await loadTraceRows(id.data));
    return Response.json(
      {
        sessionId: id.data,
        ...report,
        systemPrompt: SYSTEM_PROMPT,
        pricing: { ...PRICING_SOURCE, perMillionTokens: PRICING_PER_MTOK, realtimePerMillionTokens: REALTIME_PRICING_PER_MTOK },
      },
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
    );
  } catch (err) {
    log.error("traces failed", { requestId, sessionId: id.data }, err);
    return errorResponse(503, "unavailable", "Traces are temporarily unavailable.", requestId);
  }
}
