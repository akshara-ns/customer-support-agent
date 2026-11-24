import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { recordVoiceEvent } from "@/lib/voice/bridge";
import { productionEvents } from "@/lib/voice/deps";
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
    z.object({ kind: z.literal("user_transcript"), text: z.string().trim().min(1).max(4000) }),
    z.object({ kind: z.literal("assistant_transcript"), text: z.string().trim().min(1).max(8000), interrupted: z.boolean() }),
    z.object({ kind: z.literal("usage"), model: z.string().max(64), usage: Usage, responseId: z.string().max(100).optional() }),
  ]),
});

/** POST /api/voice/events: voice transcripts into the shared session log; realtime usage into traces. */
export async function POST(request: Request): Promise<Response> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceEvents]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const { sessionId, turnId, event } = parsed.data;
    const result = await recordVoiceEvent(sessionId, turnId, event, { events: productionEvents, traces: pgTraceWriter });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("voice event failed", err);
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
}
