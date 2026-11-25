import { z } from "zod";
import { isAdmin } from "@/lib/admin";
import { GUARDRAILS, RATE_LIMITS } from "@/lib/config";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { answerWithGuardrails } from "@/lib/guardrails/pipeline";
import { TIERS } from "@/lib/types";

/**
 * Debug view of retrieval and the guardrail decision.
 *   GET /api/rag/search?q=...            retrieval + confidence gate only (no LLM calls)
 *   GET /api/rag/search?q=...&answer=1   full pipeline: cited answer + grounding check
 * Public callers see only sections that apply to every tier, and no traces or drafts. Tier filtering
 * (&tier=pro) and full traces need the admin key (x-admin-key header = ADMIN_KEY).
 * Every call is rate limited (30 per IP per 10 min, 1,000 per day); answer=1 also 10 per IP per 10 min, 1,000 per day.
 */
const Query = z.object({
  q: z.string().trim().min(1).max(500),
  tier: z.enum(TIERS).optional(),
  answer: z.enum(["0", "1"]).optional(),
});

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), requestId);
  }
  const { q, tier, answer } = parsed.data;
  const admin = isAdmin(request);
  if (tier && !admin) {
    return errorResponse(403, "forbidden", "Tier-filtered search needs the admin key; public search covers sections for every tier.", requestId);
  }

  try {
    // Every call costs an embedding and a vector query; answer=1 also calls two LLMs, so it has a tighter cap.
    const limit = await consumeLimits(request, [...RATE_LIMITS.ragSearch, ...(answer === "1" ? RATE_LIMITS.ragAnswer : [])]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    const r = await answerWithGuardrails({ query: q, tier, generalOnly: !admin, generate: answer === "1" });
    return Response.json(
      {
        query: q,
        tier: tier ?? null,
        scope: admin ? (tier ?? "all tiers") : "sections for every tier",
        threshold: GUARDRAILS.similarityThreshold,
        decision: r.decision,
        answer: r.answer,
        draft: admin && r.decision.escalate ? r.draft : undefined,
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
        grounding: admin ? r.grounding : undefined,
        trace: admin ? { turnId: r.trace.turnId, totals: r.trace.totals(), spans: r.trace.spans } : undefined,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    log.error("rag search failed", { requestId }, err);
    return errorResponse(503, "unavailable", "Retrieval is temporarily unavailable.", requestId);
  }
}
