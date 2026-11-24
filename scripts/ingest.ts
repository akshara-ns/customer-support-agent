/**
 * Chunks data/policies/*.md, embeds changed documents and stores them in pgvector.
 * Usage: npm run ingest   (idempotent; unchanged documents are skipped)
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const { ingestCorpus } = await import("@/lib/rag/ingest");
  const t0 = performance.now();
  const r = await ingestCorpus();
  console.log(`documents:   ${r.documents} (updated ${r.updatedDocs.length}, unchanged ${r.skippedDocs.length}, removed ${r.removedDocs.length})`);
  console.log(`chunks:      ${r.chunks} (embedded this run: ${r.embedded}, ${r.embeddingTokens} tokens)`);
  for (const q of r.quarantined) console.log(`quarantined: ${q.chunkKey} [${q.flags.join(", ")}]`);
  console.log(`done in ${Math.round(performance.now() - t0)} ms`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
