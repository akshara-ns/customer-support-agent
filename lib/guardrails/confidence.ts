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
