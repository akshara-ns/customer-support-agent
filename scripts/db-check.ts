/**
 * Prints the schema state: pgvector version, public tables, embedding column type, chunk indexes.
 * Usage: npm run db:check   (reads DATABASE_URL from .env.local or the environment)
 */
import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (put it in .env.local)");
  const sql = neon(url);

  const ext = await sql`SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY 1`;
  const embedding = await sql`
    SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`;
  const indexes = await sql`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`;
  const migrations = await sql`SELECT name FROM schema_migrations ORDER BY name`;

  console.log(`pgvector:   ${ext[0]?.extversion ?? "MISSING"}`);
  console.log(`tables:     ${tables.map((r) => r.table_name).join(", ")}`);
  console.log(`embedding:  ${embedding[0]?.type ?? "MISSING"}`);
  console.log(`indexes:    ${indexes.map((r) => r.indexname).join(", ")}`);
  console.log(`migrations: ${migrations.map((r) => r.name).join(", ")}`);
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
