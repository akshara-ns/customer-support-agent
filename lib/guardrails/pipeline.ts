import "server-only";
import { GUARDRAILS } from "@/lib/config";
import { assessRetrievalConfidence, type RetrievalConfidence } from "@/lib/guardrails/confidence";
import { checkClaims, checkGrounding, type ClaimChecker, type GroundingResult } from "@/lib/guardrails/grounding";
import { Trace } from "@/lib/observability/trace";
import { generateAnswer } from "@/lib/rag/answer";
import { retrieve, type RetrieveParams } from "@/lib/rag/retrieve";
import type { Evidence, GuardrailDecision, RetrievedChunk } from "@/lib/types";

export interface GuardedAnswer {
  decision: GuardrailDecision;
  /** Present only when the decision is to answer. */
  answer: string | null;
  /** Draft answer even when escalated (debugging and evals). */
  draft: string | null;
  retrieval: { chunks: RetrievedChunk[]; confidence: RetrievalConfidence };
  grounding: GroundingResult | null;
  trace: Trace;
}

export interface GuardOptions extends RetrieveParams {
  threshold?: number;
  /** false: stop after the retrieval-confidence gate (no LLM calls). */
  generate?: boolean;
  /** Evals only: run answer + grounding even when retrieval confidence fails. */
  forceGenerate?: boolean;
}

function evidenceOf(chunks: RetrievedChunk[]): Evidence[] {
  return chunks.map((c) => ({ chunkKey: c.chunkKey, section: c.section, score: Math.round(c.score * 1000) / 1000 }));
}

/**
 * Retrieval → confidence gate → cited answer → grounding gate → typed decision.
 * Every step is a trace span; any gate failure yields `{ escalate: true, reason }`.
 */
/** The pipeline's external calls, injectable so every branch is unit-tested without API cost. */
export interface PipelineDeps {
  retrieve: typeof retrieve;
  generate: typeof generateAnswer;
  checkClaims: ClaimChecker;
}

const DEFAULT_DEPS: PipelineDeps = { retrieve, generate: generateAnswer, checkClaims };

export async function answerWithGuardrails(opts: GuardOptions, trace = new Trace(), deps: PipelineDeps = DEFAULT_DEPS): Promise<GuardedAnswer> {
  const threshold = opts.threshold ?? GUARDRAILS.similarityThreshold;
  const { chunks } = await deps.retrieve(opts, trace);
  const confidence = await trace.span("guardrail", "retrieval_confidence", { threshold }, async (s) => {
    const c = assessRetrievalConfidence(chunks, threshold);
    s.output(c);
    return c;
  });
  const evidence = evidenceOf(chunks);
  const base = { retrieval: { chunks, confidence }, trace };
  const escalate = (
    reason: Extract<GuardrailDecision, { escalate: true }>["reason"],
    detail: string,
    extra: Partial<GuardedAnswer> = {},
  ): GuardedAnswer => ({
    decision: { escalate: true, reason, confidence: confidence.topScore, evidence, detail },
    answer: null,
    draft: null,
    grounding: null,
    ...base,
    ...extra,
  });

  const lowConfidence = !confidence.pass;
  if (lowConfidence && !opts.forceGenerate) {
    return escalate("low_retrieval_confidence", `top similarity ${confidence.topScore.toFixed(3)} < threshold ${threshold}`);
  }
  if (opts.generate === false) {
    return {
      decision: { escalate: false, confidence: confidence.topScore, evidence },
      answer: null,
      draft: null,
      grounding: null,
      ...base,
    };
  }

  const draft = await deps.generate(opts.query, chunks, opts.tier, trace);
  if (draft.declined) {
    return escalate(lowConfidence ? "low_retrieval_confidence" : "answer_declined", "documents do not cover the question", {
      draft: draft.text,
    });
  }

  let grounding: GroundingResult;
  try {
    grounding = await checkGrounding(draft.text, chunks, trace, deps.checkClaims);
  } catch (err) {
    return escalate("grounding_check_failed", err instanceof Error ? err.message : "grounding check failed", {
      draft: draft.text,
    });
  }

  if (lowConfidence) {
    return escalate("low_retrieval_confidence", `top similarity ${confidence.topScore.toFixed(3)} < threshold ${threshold}`, {
      draft: draft.text,
      grounding,
    });
  }
  if (!grounding.citations.ok) {
    const reason = grounding.citations.cited.length === 0 ? "no_citations" : "invalid_citation";
    return escalate(reason, grounding.citations.invalid.length ? `invalid: ${grounding.citations.invalid.join(", ")}` : "answer cites no documents", {
      draft: draft.text,
      grounding,
    });
  }
  if (!grounding.ok) {
    return escalate("unsupported_claim", grounding.unsupported.join(" | ") || "no verifiable claims", {
      draft: draft.text,
      grounding,
    });
  }
  return {
    decision: { escalate: false, confidence: confidence.topScore, evidence },
    answer: draft.text,
    draft: draft.text,
    grounding,
    ...base,
  };
}
