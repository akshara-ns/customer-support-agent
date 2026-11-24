/**
 * Section-aware markdown chunker. Pure: no I/O, so it is unit-tested directly.
 *
 * - Each `##` / `###` section becomes one chunk, labelled with its heading path.
 * - A section longer than `maxTokens` is split on paragraph, then sentence, boundaries,
 *   and each later piece starts with ~`overlapTokens` of the previous piece's tail.
 * - Tier scope comes from the document front matter, narrowed per section by a
 *   `<!-- tiers: pro, enterprise -->` line under the heading (inherited by subsections).
 */
import { TIERS, type DocType, type Tier } from "@/lib/types";

export interface PolicyDoc {
  id: string;
  title: string;
  docType: DocType;
  tiers: Tier[];
  body: string;
}

export interface Chunk {
  chunkKey: string;
  docId: string;
  index: number;
  title: string;
  section: string;
  docType: DocType;
  tiers: Tier[];
  content: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

const DOC_TYPES: readonly DocType[] = ["policy", "troubleshooting", "faq"];

/** Approximate token count (OpenAI tokenizers average ~4 characters per English token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseTierList(raw: string, where: string): Tier[] {
  const items = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const t of items) {
    if (!(TIERS as readonly string[]).includes(t)) throw new Error(`${where}: unknown tier "${t}"`);
  }
  if (items.length === 0) throw new Error(`${where}: empty tier list`);
  return items as Tier[];
}

/** Parses the `---` front matter block (flat `key: value` and `key: [a, b]` only). */
export function parsePolicyDoc(raw: string, source = "document"): PolicyDoc {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${source}: missing front matter`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const key of ["id", "title", "doc_type", "tiers"]) {
    if (!meta[key]) throw new Error(`${source}: front matter is missing "${key}"`);
  }
  if (!(DOC_TYPES as readonly string[]).includes(meta.doc_type)) {
    throw new Error(`${source}: unknown doc_type "${meta.doc_type}"`);
  }
  return {
    id: meta.id,
    title: meta.title,
    docType: meta.doc_type as DocType,
    tiers: parseTierList(meta.tiers, source),
    body: match[2],
  };
}

interface Section {
  path: string[];
  tiers: Tier[];
  lines: string[];
}

const TIER_TAG = /^<!--\s*tiers:\s*(.+?)\s*-->$/;

function splitSections(doc: PolicyDoc): Section[] {
  const sections: Section[] = [];
  let h2: { name: string; tiers: Tier[] } | null = null;
  let current: Section = { path: ["Overview"], tiers: doc.tiers, lines: [] };

  for (const line of doc.body.split("\n")) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level === 1) continue; // document title; already in front matter
      sections.push(current);
      if (level === 2) {
        h2 = { name: heading[2], tiers: doc.tiers };
        current = { path: [heading[2]], tiers: doc.tiers, lines: [] };
      } else {
        current = { path: [h2?.name ?? "Overview", heading[2]], tiers: h2?.tiers ?? doc.tiers, lines: [] };
      }
      continue;
    }
    const tag = TIER_TAG.exec(line.trim());
    if (tag) {
      const tiers = parseTierList(tag[1], `${doc.id} > ${current.path.join(" > ")}`);
      const outside = tiers.filter((t) => !doc.tiers.includes(t));
      if (outside.length) throw new Error(`${doc.id}: section tiers ${outside.join(",")} not in document tiers`);
      current.tiers = tiers;
      if (current.path.length === 1 && h2) h2.tiers = tiers;
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections;
}

/** Removes HTML comments (author notes, fixture markers) from chunk text. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function splitSentences(paragraph: string): string[] {
  // Keep list items and table rows whole; otherwise split after sentence punctuation.
  return paragraph.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])|\n/).filter((s) => s.trim());
}

function tail(text: string, maxTokens: number): string {
  const sentences = splitSentences(text);
  const out: string[] = [];
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (estimateTokens([sentences[i], ...out].join(" ")) > maxTokens) break;
    out.unshift(sentences[i]);
  }
  return out.join(" ");
}

/** Greedy pack of paragraphs (then sentences for oversized paragraphs) under the cap, with overlap. */
function splitBySize(text: string, opts: ChunkOptions): string[] {
  if (estimateTokens(text) <= opts.maxTokens) return [text];
  const budget = opts.maxTokens - opts.overlapTokens;
  const units = text
    .split(/\n{2,}/)
    .flatMap((p) => (estimateTokens(p) > budget ? splitSentences(p) : [p]))
    .map((u) => u.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  let buf: string[] = [];
  for (const unit of units) {
    if (buf.length && estimateTokens([...buf, unit].join("\n\n")) > budget) {
      pieces.push(buf.join("\n\n"));
      buf = [];
    }
    buf.push(unit);
  }
  if (buf.length) pieces.push(buf.join("\n\n"));

  return pieces.map((piece, i) => {
    if (i === 0 || opts.overlapTokens <= 0) return piece;
    const overlap = tail(pieces[i - 1], opts.overlapTokens);
    return overlap ? `${overlap}\n\n${piece}` : piece;
  });
}

export function chunkDocument(doc: PolicyDoc, opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitSections(doc)) {
    const text = stripComments(section.lines.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    for (const piece of splitBySize(text, opts)) {
      const index = chunks.length;
      chunks.push({
        chunkKey: `${doc.id}#${index}`,
        docId: doc.id,
        index,
        title: doc.title,
        section: section.path.join(" > "),
        docType: doc.docType,
        tiers: section.tiers,
        content: piece,
        tokenCount: estimateTokens(piece),
      });
    }
  }
  return chunks;
}

/** Text that gets embedded: heading context first, so short sections still carry their topic. */
export function embeddingText(chunk: Pick<Chunk, "title" | "section" | "content">): string {
  return `${chunk.title} > ${chunk.section}\n\n${chunk.content}`;
}
