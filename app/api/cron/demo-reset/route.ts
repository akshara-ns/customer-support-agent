import { createHash, timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import { db } from "@/lib/db/client";
import { resetDemoData } from "@/lib/db/demo-reset";
import { log, newRequestId } from "@/lib/log";

/**
 * GET /api/cron/demo-reset: the daily demo reset (vercel.json `crons`). Runs only for Vercel's cron
 * call, which sends `Authorization: Bearer $CRON_SECRET`; anything else gets 401, so it is never public.
 * Same logic as `npm run demo:reset` (lib/db/demo-reset.ts).
 */
export async function GET(request: Request): Promise<Response> {
  await connection();
  const requestId = newRequestId(request);
  const secret = process.env.CRON_SECRET ?? "";
  const given = request.headers.get("authorization") ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (secret.length < 16 || !timingSafeEqual(digest(given), digest(`Bearer ${secret}`))) {
    return Response.json({ error: "unauthorized", requestId }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const result = await resetDemoData(db());
  log.info("demo reset (cron)", { requestId, ...result });
  return Response.json({ ok: true, ...result, requestId }, { headers: { "Cache-Control": "no-store" } });
}
