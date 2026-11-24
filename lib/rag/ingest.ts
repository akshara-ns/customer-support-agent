import "server-only";
import { createHash } from "node:crypto";
import { CHUNKING, MODELS } from "@/lib/config";
import { db } from "@/lib/db/client";
import { DETECTOR_VERSION, scanForInjection } from "@/lib/guardrails/injection";
import { embeddingText } from "@/lib/rag/chunker";
import { loadCorpus } from "@/lib/rag/corpus";
import { embed, toVectorLiteral } from "@/lib/rag/embed";

export interface IngestReport {
  documents: number;
  chunks: number;
  embedded: number;
  skippedDocs: string[];
  updatedDocs: string[];
  removedDocs: string[];
  quarantined: { chunkKey: string; flags: string[] }[];
  embeddingTokens: number;
}

/**
 * Idempotent: a document is re-chunked and re-embedded only when its content, the chunking
 * settings or the embedding model change (all part of the content hash). Documents removed
 * from data/policies are deleted with their chunks.
 */
export async function ingestCorpus(): Promise<IngestReport> {
  const sql = db();
  const corpus = await loadCorpus();
  const existing = new Map(
    ((await sql`SELECT slug, content_hash FROM documents`) as { slug: string; content_hash: string }[]).map((r) => [
      r.slug,
      r.content_hash,
    ]),
  );

  const report: IngestReport = {
    documents: corpus.length,
    chunks: 0,
    embedded: 0,
    skippedDocs: [],
    updatedDocs: [],
    removedDocs: [],
    quarantined: [],
    embeddingTokens: 0,
  };

  for (const { doc, raw, chunks } of corpus) {
    report.chunks += chunks.length;
    const flagged = chunks.map((c) => ({ chunk: c, flags: scanForInjection(c.content) }));
    for (const f of flagged) if (f.flags.length) report.quarantined.push({ chunkKey: f.chunk.chunkKey, flags: f.flags });

    const hash = createHash("sha256")
      .update(JSON.stringify({ raw, chunking: CHUNKING, model: MODELS.embedding, detector: DETECTOR_VERSION }))
      .digest("hex");
    if (existing.get(doc.id) === hash) {
      report.skippedDocs.push(doc.id);
      continue;
    }

    const { vectors, usage } = await embed(chunks.map(embeddingText));
    report.embedded += vectors.length;
    report.embeddingTokens += usage.tokensIn;

    await sql.transaction((tx) => [
      tx`DELETE FROM documents WHERE slug = ${doc.id}`,
      tx`INSERT INTO documents (slug, title, doc_type, tiers, content_hash)
         VALUES (${doc.id}, ${doc.title}, ${doc.docType}, ${doc.tiers}, ${hash})`,
      ...flagged.map(
        ({ chunk, flags }, i) => tx`
        INSERT INTO chunks (document_id, chunk_index, chunk_key, title, heading, doc_type, content,
                            token_count, tiers, embedding, quarantined, flags)
        VALUES ((SELECT id FROM documents WHERE slug = ${doc.id}), ${chunk.index}, ${chunk.chunkKey},
                ${chunk.title}, ${chunk.section}, ${chunk.docType}, ${chunk.content}, ${chunk.tokenCount},
                ${chunk.tiers}, ${toVectorLiteral(vectors[i])}::vector, ${flags.length > 0}, ${flags})`,
      ),
    ]);
    report.updatedDocs.push(doc.id);
  }

  const keep = corpus.map((c) => c.doc.id);
  const removed = (await sql`DELETE FROM documents WHERE NOT (slug = ANY(${keep})) RETURNING slug`) as { slug: string }[];
  report.removedDocs = removed.map((r) => r.slug);
  return report;
}
