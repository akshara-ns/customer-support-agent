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

type Health = { db: DbHealth; embeddings: DependencyHealth; llm: DependencyHealth; ok: boolean };
let cached: { at: number; value: Health } | null = null;

/** Cached for 30 s per instance, so health checks can't be used to run up provider calls. */
export async function checkAll(): Promise<Health> {
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  const [db, embeddings, llm] = await Promise.all([checkDb(), checkModel(MODELS.embedding), checkModel(MODELS.agent)]);
  const value = { db, embeddings, llm, ok: db.ok && embeddings.ok && llm.ok };
  cached = { at: Date.now(), value };
  return value;
}
