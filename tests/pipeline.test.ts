/**
 * Every branch of the guarded RAG pipeline, with fake retrieval / answer / claim-check (no API cost):
 * low confidence, retrieval-only mode, declined, no citations, invalid citation, unsupported claim,
 * checker failure, forced generation under low confidence, and the happy path.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClaimCheckResult } from "@/lib/guardrails/grounding";
import { answerWithGuardrails, type PipelineDeps } from "@/lib/guardrails/pipeline";
import type { RetrievedChunk } from "@/lib/types";

const chunk = (chunkKey: string, score: number): RetrievedChunk => ({
  chunkKey,
  docId: chunkKey.split("#")[0],
  title: "Refund Policy",
  section: "Pro tier refunds",
  docType: "policy",
  tiers: ["pro"],
  content: "Window: within 30 days. Agent limit: up to $200 per request.",
  score,
  quarantined: false,
});

function deps(opts: { top: number; draft?: string; claims?: ClaimCheckResult["claims"] | Error }): PipelineDeps & {
  generate: ReturnType<typeof vi.fn>;
  checkClaims: ReturnType<typeof vi.fn>;
} {
  const chunks = [chunk("refund-policy#3", opts.top), chunk("refund-policy#1", opts.top - 0.05)];
  return {
    retrieve: vi.fn(async () => ({ chunks, embeddingMs: 1, searchMs: 1, usage: { model: "text-embedding-3-small", tokensIn: 5, tokensOut: 0 } })),
    generate: vi.fn(async () => ({ text: opts.draft ?? "", declined: !opts.draft || opts.draft.includes("NOT_COVERED") })),
    checkClaims: vi.fn(async () => {
      if (opts.claims instanceof Error) throw opts.claims;
      return { claims: opts.claims ?? [] };
    }),
  };
}

const ask = (d: PipelineDeps, extra: Partial<Parameters<typeof answerWithGuardrails>[0]> = {}) =>
  answerWithGuardrails({ query: "What is my refund limit?", tier: "pro", threshold: 0.28, ...extra }, undefined, d);

const GOOD = "Pro refunds are up to $200 per request within 30 days [refund-policy#3].";

describe("guardrail pipeline branches", () => {
  it("low retrieval confidence → escalate before any LLM call", async () => {
    const d = deps({ top: 0.12 });
    const r = await ask(d);
    expect(r.decision).toMatchObject({ escalate: true, reason: "low_retrieval_confidence" });
    expect(d.generate).not.toHaveBeenCalled();
    expect(d.checkClaims).not.toHaveBeenCalled();
    expect(r.trace.spans.map((s) => s.name)).toContain("retrieval_confidence");
  });

  it("generate: false → retrieval-only decision, no LLM call", async () => {
    const d = deps({ top: 0.6 });
    const r = await ask(d, { generate: false });
    expect(r.decision.escalate).toBe(false);
    expect(r.answer).toBeNull();
    expect(d.generate).not.toHaveBeenCalled();
  });

  it("answer model declines (NOT_COVERED) → answer_declined", async () => {
    const r = await ask(deps({ top: 0.6, draft: "NOT_COVERED" }));
    expect(r.decision).toMatchObject({ escalate: true, reason: "answer_declined" });
  });

  it("answer without citations → no_citations (claim checker not called)", async () => {
    const d = deps({ top: 0.6, draft: "Pro refunds are up to $200." });
    const r = await ask(d);
    expect(r.decision).toMatchObject({ escalate: true, reason: "no_citations" });
    expect(d.checkClaims).not.toHaveBeenCalled();
  });

  it("citation to a chunk that wasn't retrieved → invalid_citation", async () => {
    const r = await ask(deps({ top: 0.6, draft: "Refunds are unlimited [refund-policy#9]." }));
    expect(r.decision).toMatchObject({ escalate: true, reason: "invalid_citation" });
    expect(r.decision.escalate && r.decision.detail).toContain("refund-policy#9");
  });

  it("unsupported claim → unsupported_claim with the claim in the detail", async () => {
    const r = await ask(
      deps({
        top: 0.6,
        draft: GOOD,
        claims: [
          { claim: "Pro refunds are up to $200 per request", supported: true, cited_ids: ["refund-policy#3"] },
          { claim: "within 60 days", supported: false, cited_ids: ["refund-policy#3"] },
        ],
      }),
    );
    expect(r.decision).toMatchObject({ escalate: true, reason: "unsupported_claim" });
    expect(r.decision.escalate && r.decision.detail).toContain("within 60 days");
  });

  it("claim checker returns no claims → unsupported_claim (nothing verifiable)", async () => {
    const r = await ask(deps({ top: 0.6, draft: GOOD, claims: [] }));
    expect(r.decision).toMatchObject({ escalate: true, reason: "unsupported_claim" });
  });

  it("claim checker throws → grounding_check_failed", async () => {
    const r = await ask(deps({ top: 0.6, draft: GOOD, claims: new Error("checker timed out") }));
    expect(r.decision).toMatchObject({ escalate: true, reason: "grounding_check_failed", detail: "checker timed out" });
    expect(r.draft).toBe(GOOD);
  });

  it("forceGenerate under low confidence still escalates on confidence, but records the draft and grounding", async () => {
    const r = await ask(deps({ top: 0.2, draft: GOOD, claims: [{ claim: "x", supported: true, cited_ids: ["refund-policy#3"] }] }), {
      forceGenerate: true,
    });
    expect(r.decision).toMatchObject({ escalate: true, reason: "low_retrieval_confidence" });
    expect(r.draft).toBe(GOOD);
    expect(r.grounding?.ok).toBe(true);
  });

  it("grounded answer above threshold → answered, with evidence and confidence", async () => {
    const r = await ask(deps({ top: 0.6, draft: GOOD, claims: [{ claim: "Pro refunds are up to $200", supported: true, cited_ids: ["refund-policy#3"] }] }));
    expect(r.decision).toMatchObject({ escalate: false, confidence: 0.6 });
    expect(r.answer).toBe(GOOD);
    expect(r.decision.evidence.map((e) => e.chunkKey)).toEqual(["refund-policy#3", "refund-policy#1"]);
  });
});
