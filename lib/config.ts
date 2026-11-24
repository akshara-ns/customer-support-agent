/**
 * Pinned models, prices and RAG/guardrail parameters. The one place to change them.
 * Prices are USD per 1M tokens (OpenAI list prices, checked 2026-11-23).
 */

export const MODELS = {
  embedding: "text-embedding-3-small",
  /** Generates cited answers from retrieved chunks. */
  answer: "gpt-5.4-mini",
  /** Secondary claim-support check. Chosen by the sanity check in evals/RESULTS.md. */
  groundingCheck: "gpt-5.4-nano",
  /** Agent loop (tool selection + replies). Chosen by the live scenario run; see DECISIONS.md. */
  agent: "gpt-5.4-mini",
} as const;

export const EMBEDDING_DIMENSIONS = 1536;

export const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
};

export const CHUNKING = {
  /** Hard cap per chunk (approximate tokens: chars / 4). */
  maxTokens: 350,
  /** Tail of the previous piece repeated at the start of the next when a section is split. */
  overlapTokens: 40,
} as const;

export const RETRIEVAL = {
  topK: 5,
} as const;

export const GUARDRAILS = {
  /**
   * Minimum top-1 cosine similarity to attempt an answer. Calibrated by
   * `npm run eval:guardrails` on the calibration split; see evals/RESULTS.md.
   */
  similarityThreshold: 0.28,
  /** Per-call timeout for the answer and grounding-check models. */
  llmTimeoutMs: 20_000,
} as const;

/** Abuse and cost limits for public endpoints (lib/ratelimit.ts). */
export const RATE_LIMITS = {
  ragAnswer: [
    { bucket: "rag_answer:ip", scope: "ip", limit: 10, windowSec: 600 },
    { bucket: "rag_answer:daily", scope: "global", limit: 200, windowSec: 86_400 },
  ],
  chat: [
    { bucket: "chat:ip", scope: "ip", limit: 30, windowSec: 600 },
    { bucket: "chat:daily", scope: "global", limit: 600, windowSec: 86_400 },
  ],
} as const;
