import "server-only";
import { z } from "zod";

/**
 * Server-side environment, validated on first use. Never import from client components:
 * `server-only` makes the build fail if this module reaches the browser bundle.
 */
const schema = z.object({
  DATABASE_URL: z.url(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  /** Unlocks tier filtering and full traces on /api/rag/search (header x-admin-key). Optional. */
  ADMIN_KEY: z.string().min(16).optional(),
  /** Vercel sends it as `Authorization: Bearer …` on cron calls (/api/cron/demo-reset). Optional locally. */
  CRON_SECRET: z.string().min(16).optional(),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid server environment: ${fields}`);
  }
  cached = parsed.data;
  return cached;
}
