import { connection } from "next/server";
import { checkAll } from "@/lib/health";
import type { HealthResponse } from "@/lib/types";

/** GET /api/health → DB (+ pgvector, migrations), embeddings and LLM reachability. 503 if any is down. */
export async function GET(): Promise<Response> {
  await connection(); // always run at request time, never prerendered
  const h = await checkAll();
  const body: HealthResponse = {
    status: h.ok ? "ok" : "error",
    db: h.db,
    embeddings: h.embeddings,
    llm: h.llm,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  };
  return Response.json(body, { status: h.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
