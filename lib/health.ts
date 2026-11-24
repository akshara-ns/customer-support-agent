import "server-only";
import { MODELS } from "@/lib/config";
import { checkDb } from "@/lib/db/health";
import { openai } from "@/lib/openai";
import type { DbHealth } from "@/lib/types";

export interface DependencyHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Reachability of the embeddings and chat models: a model-metadata lookup (authenticated, no
 * tokens billed), with a short timeout so health never hangs.
 */
async function checkModel(model: string): Promise<DependencyHealth> {
  const t0 = performance.now();
  try {
    await openai().models.retrieve(model, { timeout: 4000, maxRetries: 0 });
    return { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - t0), error: err instanceof Error ? err.message.slice(0, 120) : "unreachable" };
  }
}

export async function checkAll(): Promise<{ db: DbHealth; embeddings: DependencyHealth; llm: DependencyHealth; ok: boolean }> {
  const [db, embeddings, llm] = await Promise.all([checkDb(), checkModel(MODELS.embedding), checkModel(MODELS.agent)]);
  return { db, embeddings, llm, ok: db.ok && embeddings.ok && llm.ok };
}
