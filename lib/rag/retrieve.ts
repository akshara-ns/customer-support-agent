import "server-only";
import { RETRIEVAL } from "@/lib/config";
import { db } from "@/lib/db/client";
import { embed, toVectorLiteral } from "@/lib/rag/embed";
import type { Trace, Usage } from "@/lib/observability/trace";
import type { DocType, RetrievedChunk, Tier } from "@/lib/types";

export interface RetrieveParams {
  query: string;
  /** The verified customer's tier. Chunks scoped to other tiers are excluded. Omit for no tier filter. */
  tier?: Tier;
  topK?: number;
  /** Include chunks quarantined by the injection scan (debugging and evals only). */
  includeQuarantined?: boolean;
  /** Unverified caller: only sections that apply to every tier (no tier-specific limits). */
  generalOnly?: boolean;
  /** Exclude whole documents (evals: compare decisions with and without a document). */
  excludeDocIds?: string[];
}

export interface RetrieveResult {
  chunks: RetrievedChunk[];
  embeddingMs: number;
  searchMs: number;
  usage: Usage;
}

interface ChunkRow {
  chunk_key: string;
  doc_id: string;
  title: string;
  section: string;
  doc_type: DocType;
  tiers: Tier[];
  content: string;
  quarantined: boolean;
  score: number;
}

/**
 * Cosine top-k over pgvector with tier and quarantine filters applied in SQL.
 * `hnsw.iterative_scan` keeps scanning the HNSW index until k rows pass the filters,
 * so a narrow tier filter cannot silently return fewer than k results.
 */
export async function retrieve(params: RetrieveParams, trace?: Trace): Promise<RetrieveResult> {
  const run = async (): Promise<RetrieveResult> => {
    const t0 = performance.now();
    const { vectors, usage } = await embed([params.query]);
    const embeddingMs = Math.round(performance.now() - t0);
    const vec = toVectorLiteral(vectors[0]);
    const tier = params.tier ?? null;
    const includeQuarantined = params.includeQuarantined ?? false;
    const exclude = params.excludeDocIds ?? [];
    const generalOnly = params.generalOnly ?? false;
    const allTiers = ["free", "pro", "enterprise"];
    const k = params.topK ?? RETRIEVAL.topK;

    const sql = db();
    const t1 = performance.now();
    const [, rows] = await sql.transaction((tx) => [
      tx`SET LOCAL hnsw.iterative_scan = strict_order`,
      tx`
        SELECT c.chunk_key, d.slug AS doc_id, c.title, c.heading AS section, c.doc_type, c.tiers,
               c.content, c.quarantined, 1 - (c.embedding <=> ${vec}::vector) AS score
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE (${tier}::text IS NULL OR ${tier}::text = ANY(c.tiers))
          AND (${includeQuarantined}::boolean OR NOT c.quarantined)
          AND NOT (d.slug = ANY(${exclude}::text[]))
          AND (NOT ${generalOnly}::boolean OR c.tiers @> ${allTiers}::text[])
        ORDER BY c.embedding <=> ${vec}::vector
        LIMIT ${k}`,
    ]);
    const searchMs = Math.round(performance.now() - t1);

    const chunks = (rows as ChunkRow[]).map((r) => ({
      chunkKey: r.chunk_key,
      docId: r.doc_id,
      title: r.title,
      section: r.section,
      docType: r.doc_type,
      tiers: r.tiers,
      content: r.content,
      quarantined: r.quarantined,
      score: Number(r.score),
    }));
    return { chunks, embeddingMs, searchMs, usage };
  };

  if (!trace) return run();
  return trace.span("retrieval", "retrieve_policy", { query: params.query, tier: params.tier ?? null }, async (s) => {
    const result = await run();
    s.usage(result.usage);
    s.output({
      embeddingMs: result.embeddingMs,
      searchMs: result.searchMs,
      results: result.chunks.map((c) => ({ chunkKey: c.chunkKey, score: round(c.score) })),
    });
    return result;
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
