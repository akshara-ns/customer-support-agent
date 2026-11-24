import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";

export interface Limit {
  /** Counter namespace, e.g. "rag_answer:ip". */
  bucket: string;
  limit: number;
  windowSec: number;
  /** "ip" counts per client IP; "global" is one shared counter (a daily cost cap). */
  scope: "ip" | "global";
}

export interface LimitResult {
  allowed: boolean;
  bucket: string;
  count: number;
  limit: number;
  retryAfterSec: number;
}

/** Client IP as seen by Vercel's proxy, hashed so raw IPs are never stored. */
export function clientKey(request: Request): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

/**
 * Fixed-window counters in Postgres (shared by all serverless instances). Limits are checked
 * in order; the first one exceeded stops the request and later counters are not consumed.
 */
export async function consumeLimits(request: Request, limits: Limit[]): Promise<LimitResult> {
  const sql = db();
  const ipKey = clientKey(request);
  let last: LimitResult = { allowed: true, bucket: "", count: 0, limit: 0, retryAfterSec: 0 };
  for (const l of limits) {
    const key = l.scope === "ip" ? ipKey : "all";
    const rows = (await sql`
      INSERT INTO rate_limits (bucket, key, window_start, count)
      VALUES (${l.bucket}, ${key}, to_timestamp(floor(extract(epoch FROM now()) / ${l.windowSec}) * ${l.windowSec}), 1)
      ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count, extract(epoch FROM (window_start + make_interval(secs => ${l.windowSec}) - now()))::int AS retry_after
    `) as { count: number; retry_after: number }[];
    const { count, retry_after } = rows[0];
    last = { allowed: count <= l.limit, bucket: l.bucket, count, limit: l.limit, retryAfterSec: Math.max(1, retry_after) };
    if (!last.allowed) break;
  }
  if (Math.random() < 0.01) {
    await sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  }
  return last;
}

export function rateLimitedResponse(r: LimitResult): Response {
  const daily = r.bucket.endsWith(":daily");
  return Response.json(
    {
      error: "rate_limited",
      message: daily
        ? "The demo's daily usage cap has been reached. Please try again tomorrow."
        : "Too many requests. Please wait a moment and try again.",
      retryAfterSec: r.retryAfterSec,
    },
    { status: 429, headers: { "Retry-After": String(r.retryAfterSec), "Cache-Control": "no-store" } },
  );
}
