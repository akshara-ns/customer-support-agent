import "server-only";
import { db } from "@/lib/db/client";
import type { DbHealth } from "@/lib/types";

/** Checks connectivity, the pgvector extension and applied migrations. Never throws. */
export async function checkDb(): Promise<DbHealth> {
  const started = performance.now();
  try {
    const rows = (await db()`
      SELECT
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector,
        (SELECT count(*)::int FROM schema_migrations) AS migrations
    `) as { pgvector: string | null; migrations: number }[];
    const row = rows[0];
    return {
      ok: row?.pgvector != null && (row?.migrations ?? 0) > 0,
      latencyMs: Math.round(performance.now() - started),
      pgvector: row?.pgvector ?? null,
      migrations: row?.migrations ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      pgvector: null,
      migrations: 0,
      // Postgres/driver messages don't include the connection string; keep only the message.
      error: err instanceof Error ? err.message : "unknown database error",
    };
  }
}
