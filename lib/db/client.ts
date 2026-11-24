import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { serverEnv } from "@/lib/env";

let sql: NeonQueryFunction<false, false> | undefined;

/** Lazily created Neon HTTP query function (one round trip per query, fits serverless). */
export function db(): NeonQueryFunction<false, false> {
  sql ??= neon(serverEnv().DATABASE_URL);
  return sql;
}
