import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
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
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceSession]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const key = serverEnv().OPENAI_API_KEY;
    if (!key) return Response.json({ error: "unavailable", message: "Voice is not configured." }, { status: 503 });
    const session = await createVoiceSession(parsed.data.sessionId, {
      events: productionEvents,
      tools: productionToolDeps(),
      mint: openAISecretMinter(key),
    });
    return Response.json(session, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("voice session failed", err);
    return Response.json({ error: "unavailable", message: "Couldn't start a voice session. Please try again." }, { status: 503 });
  }
}
