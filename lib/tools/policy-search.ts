import "server-only";
/**
 * get_policy backend: the calibrated retrieval + grounding pipeline. Before verification only sections
 * for every tier are searched. If that escalates but the answer lives in tier-specific sections
 * (a retrieval-only check across tiers passes the threshold), the customer is asked to verify instead
 * of being escalated: their tier decides the answer.
 */
import type { answerWithGuardrails as Pipeline } from "@/lib/guardrails/pipeline";
import type { PolicySearch } from "@/lib/tools/stores";
import { TIERS } from "@/lib/types";

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The customer asks about their own plan or account ("What's my refund limit?", "How long do I have
 * to request a refund?", "What does my plan include?"): the answer depends on their tier.
 */
export const OWN_PLAN =
  /\b(my|our|i|we)\b[^.?!]*\b(plan|tier|subscription|account|workspace|limit|limits|refunds?|window|invoices?|billing|seats?|storage|members?|integrations?|version history|support|sso|include|includes)\b/i;

export function policySearchWith(answer: typeof Pipeline): PolicySearch {
  return {
    async search(question, tier, trace) {
      const r = await answer({ query: question, tier: tier ?? undefined, generalOnly: tier === null }, trace);
      if (!r.decision.escalate && r.answer) {
        const level = r.level === "high" ? "high" : "medium";
        return {
          status: "answered",
          answer: r.answer,
          citations: r.grounding?.citations.cited ?? [],
          confidence: round(r.decision.confidence),
          level,
          ...(level === "medium"
            ? { next_step: "Medium confidence: give this answer, say it's based on the closest policy section, and offer a person if they need it confirmed." }
            : {}),
        };
      }
      const escalation = {
        status: "needs_escalation" as const,
        reason: r.decision.escalate ? r.decision.reason : "no_answer",
        confidence: round(r.decision.confidence),
      };
      if (tier !== null) return escalation;
      // Unverified: does the answer depend on their tier? Retrieval only, no LLM call. Yes if the cross-tier
      // search is relevant (passes the threshold) and either its best match is tier-specific or the
      // question is about their own plan. Off-topic questions fail the threshold and still escalate.
      const all = await answer({ query: question, generate: false }, trace);
      const top = all.retrieval.chunks[0];
      if (!all.decision.escalate && top && (top.tiers.length < TIERS.length || OWN_PLAN.test(question))) {
        return {
          status: "needs_verification",
          reason: "tier_specific",
          confidence: round(all.decision.confidence),
          tiers: top.tiers,
          next_step: "The answer depends on the customer's plan. Ask for their email and 6-digit support PIN to answer for their plan; offer a person only if they decline or verification fails.",
        };
      }
      return escalation;
    },
  };
}
