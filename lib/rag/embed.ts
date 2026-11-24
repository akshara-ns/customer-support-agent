import "server-only";
import { EMBEDDING_DIMENSIONS, MODELS } from "@/lib/config";
import OpenAI from "openai";
import { activeFault } from "@/lib/faults";
import { openai } from "@/lib/openai";
import type { Usage } from "@/lib/observability/trace";

export async function embed(texts: string[]): Promise<{ vectors: number[][]; usage: Usage }> {
  // Simulated outage: same call against an unreachable host, so a real connection error surfaces.
  const client = activeFault() === "retrieval_down" ? new OpenAI({ apiKey: "unused", baseURL: "http://127.0.0.1:9/v1", maxRetries: 0, timeout: 3000 }) : openai();
  const res = await client.embeddings.create({
    model: MODELS.embedding,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  const vectors = res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`embedding size mismatch: expected ${EMBEDDING_DIMENSIONS}`);
  }
  return { vectors, usage: { model: MODELS.embedding, tokensIn: res.usage.prompt_tokens, tokensOut: 0 } };
}

/** pgvector literal for a query parameter, e.g. `${toVectorLiteral(v)}::vector`. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
