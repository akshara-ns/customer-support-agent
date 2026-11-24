import type { RetrievedChunk } from "@/lib/types";

export interface RetrievalConfidence {
  pass: boolean;
  /** Top-1 cosine similarity (0 when nothing was retrieved). */
  topScore: number;
  /** Gap between the top-1 and top-2 scores; reported as evidence, not used in the decision. */
  margin: number;
  threshold: number;
}

/** Gate 1: is the best retrieved chunk similar enough to the question to attempt an answer? */
export function assessRetrievalConfidence(chunks: RetrievedChunk[], threshold: number): RetrievalConfidence {
  const scores = chunks.map((c) => c.score).sort((a, b) => b - a);
  const topScore = scores[0] ?? 0;
  const margin = scores.length > 1 ? topScore - scores[1] : topScore;
  return { pass: topScore >= threshold, topScore, margin, threshold };
}

/** HIGH: answer as is. MEDIUM: answer with a hedge. LOW: escalate. Shown to customers instead of raw cosine. */
export type ConfidenceLevel = "high" | "medium" | "low";

/** Best score per document, then best minus second-best document (chunks of one doc don't count as rivals). */
export function docMargin(chunks: RetrievedChunk[]): number {
  const best = new Map<string, number>();
  for (const c of chunks) best.set(c.docId, Math.max(best.get(c.docId) ?? 0, c.score));
  const docs = [...best.values()].sort((a, b) => b - a);
  return (docs[0] ?? 0) - (docs[1] ?? 0);
}

/**
 * The 3-level score: LOW when the guardrail escalated; HIGH when the answer is grounded with no trimming,
 * top-1 ≥ highTop1 and the doc-level margin ≥ highDocMargin; otherwise MEDIUM (grounded, but weak or
 * ambiguous retrieval, or partly grounded).
 */
export function confidenceLevel(a: { escalated: boolean; partial: boolean; topScore: number; docMargin: number; highTop1: number; highDocMargin: number }): ConfidenceLevel {
  if (a.escalated) return "low";
  if (!a.partial && a.topScore >= a.highTop1 && a.docMargin >= a.highDocMargin) return "high";
  return "medium";
}
