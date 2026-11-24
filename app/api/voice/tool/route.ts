import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { FAULTS, runWithFault } from "@/lib/faults";
import { authorizeSession, ownerFromRequest, withOwnerCookie } from "@/lib/session/owner";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { persistTrace } from "@/lib/observability/pg-traces";
import { clientKey, consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { runVoiceTool } from "@/lib/voice/bridge";
import { productionEvents, productionToolDeps } from "@/lib/server/deps";

export const maxDuration = 30;

const Body = z.object({
  sessionId: z.uuid(),
  turnId: z.uuid(),
  callId: z.string().min(1).max(100),
  name: z.string().min(1).max(64),
  arguments: z.string().max(4000),
  /** Demo failure simulation for this one tool call (tool_failure, retrieval_down). */
  simulate: z.enum(FAULTS).optional(),
});

/**
 * POST /api/voice/tool: the realtime model's function call, executed by the SAME tool step as
 * chat (validation, identity preconditions, policy, ledger, logging). No tool logic in the browser.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid tool call.", requestId);
  const { sessionId } = parsed.data;
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceTool]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const owner = ownerFromRequest(request);
    if (!(await authorizeSession(sessionId, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
    const result = await runWithFault(parsed.data.simulate, () =>
      runVoiceTool(parsed.data, {
        events: productionEvents,
        tools: productionToolDeps(),
        traceSink: (trace, channel) => persistTrace(sessionId, trace, channel),
        clientKey: clientKey(request),
      }),
    );
    log.info("voice tool", { requestId, sessionId, tool: parsed.data.name, ok: result.ok, simulate: parsed.data.simulate });
    return withOwnerCookie(Response.json(result, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } }), owner);
  } catch (err) {
    log.error("voice tool failed", { requestId, sessionId, tool: parsed.data.name }, err);
    // Still a valid function output, so the model can tell the caller instead of hanging.
    const output = JSON.stringify({
      ok: false,
      error: { code: "TOOL_FAILURE", message: "The system couldn't complete this step. Nothing was changed.", retryable: true },
    });
    return Response.json({ output, ok: false, events: [] }, { status: 200, headers: { "x-request-id": requestId } });
  }
}
