import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { authorizeSession, ownerFromRequest, withOwnerCookie } from "@/lib/session/owner";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { serverEnv } from "@/lib/env";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { createVoiceSession, openAISecretMinter } from "@/lib/voice/session";
import { productionEvents, productionToolDeps } from "@/lib/voice/deps";

const Body = z.object({ sessionId: z.uuid() });

/**
 * POST /api/voice/session → a short-lived realtime client secret (`ek_…`) plus the session's
 * recent history. The standard API key stays on the server. Rate limited and capped per day.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid request body.", requestId);
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceSession]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const owner = ownerFromRequest(request);
    if (!(await authorizeSession(parsed.data.sessionId, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
    const key = serverEnv().OPENAI_API_KEY;
    if (!key) return errorResponse(503, "unavailable", "Voice is not configured.", requestId);
    const session = await createVoiceSession(parsed.data.sessionId, {
      events: productionEvents,
      tools: productionToolDeps(),
      mint: openAISecretMinter(key),
    });
    return withOwnerCookie(Response.json(session, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } }), owner);
  } catch (err) {
    log.error("voice session failed", { requestId, sessionId: parsed.data.sessionId }, err);
    return errorResponse(503, "unavailable", "Couldn't start a voice session. Please try again.", requestId);
  }
}
