/** Loads and chunks the policy corpus from data/policies (Node only: used by scripts and tests). */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CHUNKING } from "@/lib/config";
import { chunkDocument, parsePolicyDoc, type Chunk, type PolicyDoc } from "@/lib/rag/chunker";

export const POLICY_DIR = path.join(process.cwd(), "data", "policies");

export interface LoadedDoc {
  doc: PolicyDoc;
  raw: string;
  chunks: Chunk[];
}

export async function loadCorpus(dir = POLICY_DIR): Promise<LoadedDoc[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const out: LoadedDoc[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    const doc = parsePolicyDoc(raw, file);
    if (ids.has(doc.id)) throw new Error(`duplicate document id "${doc.id}" in ${file}`);
    ids.add(doc.id);
    out.push({ doc, raw, chunks: chunkDocument(doc, CHUNKING) });
  }
  return out;
}
