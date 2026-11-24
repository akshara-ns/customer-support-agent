import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { runVoiceTool } from "@/lib/voice/bridge";
import { productionEvents, productionToolDeps } from "@/lib/voice/deps";

export const maxDuration = 30;

const Body = z.object({
  sessionId: z.uuid(),
  turnId: z.uuid(),
  callId: z.string().min(1).max(100),
  name: z.string().min(1).max(64),
  arguments: z.string().max(4000),
});

/**
 * POST /api/voice/tool: the realtime model's function call, executed by the SAME tool step as
 * chat (validation, identity preconditions, policy, ledger, logging). No tool logic in the browser.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.voiceTool]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const result = await runVoiceTool(parsed.data, { events: productionEvents, tools: productionToolDeps() });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("voice tool failed", err);
    // Still a valid function output, so the model can tell the caller instead of hanging.
    const output = JSON.stringify({
      ok: false,
      error: { code: "TOOL_FAILURE", message: "The system couldn't complete this step. Nothing was changed.", retryable: true },
    });
    return Response.json({ output, ok: false, events: [] }, { status: 200 });
  }
}
