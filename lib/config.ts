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
  /** Voice: speech-to-speech over WebRTC. The mini model is 3.2x cheaper on audio than gpt-realtime-2.1. */
  realtime: "gpt-realtime-2.1-mini",
  /** Live transcription of the caller's speech inside the realtime session. */
  realtimeTranscribe: "gpt-4o-mini-transcribe",
} as const;

export const EMBEDDING_DIMENSIONS = 1536;

export const PRICING_PER_MTOK: Record<string, { input: number; output: number; cachedInput?: number }> = {
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cachedInput: 0.005 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cachedInput: 0.02 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cachedInput: 0.075 },
};

/** Shown next to every cost in the UI: costs are estimates from this table, not invoices. */
export const PRICING_SOURCE = {
  checked: "2026-11-23",
  source: "OpenAI API pricing page (developers.openai.com/api/docs/pricing) and model pages",
  note: "Estimated: provider-reported token usage x list prices. Excludes taxes, discounts and batch pricing.",
} as const;

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
  /** Every /api/rag/search call (each costs an embedding + a vector query). */
  ragSearch: [
    { bucket: "rag_search:ip", scope: "ip", limit: 30, windowSec: 600 },
    { bucket: "rag_search:daily", scope: "global", limit: 1000, windowSec: 86_400 },
  ],
  ragAnswer: [
    { bucket: "rag_answer:ip", scope: "ip", limit: 10, windowSec: 600 },
    { bucket: "rag_answer:daily", scope: "global", limit: 200, windowSec: 86_400 },
  ],
  chat: [
    { bucket: "chat:ip", scope: "ip", limit: 30, windowSec: 600 },
    { bucket: "chat:daily", scope: "global", limit: 600, windowSec: 86_400 },
  ],
  voiceSession: [
    { bucket: "voice_session:ip", scope: "ip", limit: 6, windowSec: 600 },
    { bucket: "voice_session:daily", scope: "global", limit: 60, windowSec: 86_400 },
  ],
  voiceTool: [
    { bucket: "voice_tool:ip", scope: "ip", limit: 60, windowSec: 600 },
    { bucket: "voice_tool:daily", scope: "global", limit: 1500, windowSec: 86_400 },
  ],
  voiceEvents: [{ bucket: "voice_events:ip", scope: "ip", limit: 300, windowSec: 600 }],
} as const;

/** Realtime pricing, USD per 1M tokens (OpenAI pricing page, checked 2026-11-23). */
export const REALTIME_PRICING_PER_MTOK: Record<string, { audioIn: number; audioOut: number; textIn: number; textOut: number; cachedIn: number }> = {
  "gpt-realtime-2.1-mini": { audioIn: 10, audioOut: 20, textIn: 0.6, textOut: 2.4, cachedIn: 0.3 },
  "gpt-realtime-2.1": { audioIn: 32, audioOut: 64, textIn: 4, textOut: 24, cachedIn: 0.4 },
};

export const VOICE = {
  voice: "marin",
  /** Hard cap per voice session (cost control); the client ends the call and shows a timer. */
  maxSessionSeconds: 180,
  /** The ephemeral key only needs to live long enough to complete the SDP exchange. */
  clientSecretTtlSeconds: 60,
  /** Recent chat/voice messages replayed into a new voice session. */
  historyMessages: 12,
  /** Per realtime response, enforced server-side by OpenAI (~1 minute of speech). */
  maxOutputTokens: 1500,
} as const;
