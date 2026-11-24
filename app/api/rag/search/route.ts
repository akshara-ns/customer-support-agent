import { z } from "zod";
import { GUARDRAILS, RATE_LIMITS } from "@/lib/config";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { answerWithGuardrails } from "@/lib/guardrails/pipeline";
import { TIERS } from "@/lib/types";

/**
 * Debug view of retrieval and the guardrail decision.
 *   GET /api/rag/search?q=...&tier=pro            retrieval + confidence gate only (no LLM calls)
 *   GET /api/rag/search?q=...&tier=pro&answer=1   full pipeline: cited answer + grounding check
 *                                                 (rate limited: 10 per IP per 10 min, 200 per day)
 */
const Query = z.object({
  q: z.string().trim().min(1).max(500),
  tier: z.enum(TIERS).optional(),
  answer: z.enum(["0", "1"]).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_query", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
      { status: 400 },
    );
  }
  const { q, tier, answer } = parsed.data;

  try {
    // answer=1 calls two LLMs; cap it per IP and per day so the public endpoint can't run up cost.
    if (answer === "1") {
      const limit = await consumeLimits(request, [...RATE_LIMITS.ragAnswer]);
      if (!limit.allowed) return rateLimitedResponse(limit);
    }
    const r = await answerWithGuardrails({ query: q, tier, generate: answer === "1" });
    return Response.json(
      {
        query: q,
        tier: tier ?? null,
        threshold: GUARDRAILS.similarityThreshold,
        decision: r.decision,
        answer: r.answer,
        draft: r.decision.escalate ? r.draft : undefined,
        retrieval: {
          topScore: r.retrieval.confidence.topScore,
          margin: r.retrieval.confidence.margin,
          chunks: r.retrieval.chunks.map((c) => ({
            chunkKey: c.chunkKey,
            section: `${c.title} > ${c.section}`,
            score: Math.round(c.score * 1000) / 1000,
            tiers: c.tiers,
            preview: c.content.slice(0, 160),
          })),
        },
        grounding: r.grounding,
        trace: { turnId: r.trace.turnId, totals: r.trace.totals(), spans: r.trace.spans },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("rag/search failed", err);
    return Response.json({ error: "search_failed", message: "Retrieval is temporarily unavailable." }, { status: 503 });
  }
}
