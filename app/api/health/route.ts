import { connection } from "next/server";
import { checkDb } from "@/lib/db/health";
import type { HealthResponse } from "@/lib/types";

export async function GET(): Promise<Response> {
  await connection(); // always run at request time, never prerendered
  const dbHealth = await checkDb();
  const body: HealthResponse = {
    status: dbHealth.ok ? "ok" : "error",
    db: dbHealth,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    time: new Date().toISOString(),
  };
  return Response.json(body, {
    status: dbHealth.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
