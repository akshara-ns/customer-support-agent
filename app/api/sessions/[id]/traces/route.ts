import { z } from "zod";
import { PRICING_PER_MTOK, PRICING_SOURCE, REALTIME_PRICING_PER_MTOK } from "@/lib/config";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { authorizeSession, ownerFromRequest, withOwnerCookie } from "@/lib/session/owner";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { loadTraceRows } from "@/lib/observability/pg-traces";
import { buildReport } from "@/lib/observability/report";

/** GET /api/sessions/:id/traces: the observability drawer's data for one session. */
export async function GET(request: Request, ctx: RouteContext<"/api/sessions/[id]/traces">): Promise<Response> {
  const requestId = newRequestId(request);
  const id = z.uuid().safeParse((await ctx.params).id);
  if (!id.success) return errorResponse(400, "invalid_request", "Session id must be a UUID.", requestId);
  const owner = ownerFromRequest(request);
  try {
    if (!(await authorizeSession(id.data, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
    const report = buildReport(await loadTraceRows(id.data));
    return withOwnerCookie(Response.json(
      {
        sessionId: id.data,
        ...report,
        systemPrompt: SYSTEM_PROMPT,
        pricing: { ...PRICING_SOURCE, perMillionTokens: PRICING_PER_MTOK, realtimePerMillionTokens: REALTIME_PRICING_PER_MTOK },
      },
      { headers: { "Cache-Control": "no-store", "x-request-id": requestId } },
    ), owner);
  } catch (err) {
    log.error("traces failed", { requestId, sessionId: id.data }, err);
    return errorResponse(503, "unavailable", "Traces are temporarily unavailable.", requestId);
  }
}
