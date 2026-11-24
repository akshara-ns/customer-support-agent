import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { authorizeSession, ownerFromRequest, withOwnerCookie } from "@/lib/session/owner";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { recordVoiceEvent } from "@/lib/voice/bridge";
import { productionActionChecker, productionEvents } from "@/lib/server/deps";
import { pgTraceWriter } from "@/lib/voice/pg";

const Usage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    input_token_details: z.object({ text_tokens: z.number().optional(), audio_tokens: z.number().optional(), cached_tokens: z.number().optional() }).partial().optional(),
    output_token_details: z.object({ text_tokens: z.number().optional(), audio_tokens: z.number().optional() }).partial().optional(),
  })
  .passthrough();

const Body = z.object({
  sessionId: z.uuid(),
  turnId: z.uuid(),
  event: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user_transcript"), text: z.string().trim().min(1).max(4000), at: z.number().int().positive().optional() }),
    z.object({ kind: z.literal("assistant_transcript"), text: z.string().trim().min(1).max(8000), interrupted: z.boolean(), at: z.number().int().positive().optional() }),
    z.object({
      kind: z.literal("usage"),
      model: z.string().max(64),
      usage: Usage,
      responseId: z.string().max(100).optional(),
      latencyMs: z.number().min(0).max(120_000).optional(),
      durationMs: z.number().int().min(0).max(600_000).optional(),
    }),
  ]),
});

/** POST /api/voice/events: voice transcripts into the shared session log; realtime usage into traces. */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Invalid request body.", requestId);
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceEvents]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const owner = ownerFromRequest(request);
    if (!(await authorizeSession(parsed.data.sessionId, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
    const { sessionId, turnId, event } = parsed.data;
    const result = await recordVoiceEvent(sessionId, turnId, event, { events: productionEvents, traces: pgTraceWriter, actionChecker: productionActionChecker });
    return withOwnerCookie(Response.json(result, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } }), owner);
  } catch (err) {
    log.error("voice event failed", { requestId, sessionId: parsed.data.sessionId }, err);
    return errorResponse(503, "unavailable", "Couldn't record the voice event.", requestId);
  }
}
