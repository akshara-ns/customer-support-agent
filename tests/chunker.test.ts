import { describe, expect, it } from "vitest";
import { chunkDocument, embeddingText, estimateTokens, parsePolicyDoc } from "@/lib/rag/chunker";
import { loadCorpus } from "@/lib/rag/corpus";
import { scanForInjection } from "@/lib/guardrails/injection";
import { CHUNKING } from "@/lib/config";

const OPTS = { maxTokens: 350, overlapTokens: 40 };

const DOC = `---
id: sample
title: Sample Policy
doc_type: policy
tiers: [free, pro, enterprise]
---

# Sample Policy

Intro paragraph that applies to everyone.

## General rules

Rule text for all tiers.

<!-- author note: must not reach the chunk -->

## Paid refunds

<!-- tiers: pro, enterprise -->

Paid refund rules.

### Enterprise credits

Credits text, inherits the parent's tiers.

### Enterprise only

<!-- tiers: enterprise -->

Only for enterprise.
`;

describe("parsePolicyDoc", () => {
  it("reads front matter", () => {
    const doc = parsePolicyDoc(DOC);
    expect(doc).toMatchObject({ id: "sample", title: "Sample Policy", docType: "policy", tiers: ["free", "pro", "enterprise"] });
  });

  it("rejects missing fields and unknown tiers", () => {
    expect(() => parsePolicyDoc("# no front matter")).toThrow(/missing front matter/);
    expect(() => parsePolicyDoc(DOC.replace("doc_type: policy\n", ""))).toThrow(/doc_type/);
    expect(() => parsePolicyDoc(DOC.replace("[free, pro, enterprise]", "[free, gold]"))).toThrow(/unknown tier "gold"/);
  });
});

describe("chunkDocument", () => {
  const chunks = chunkDocument(parsePolicyDoc(DOC), OPTS);

  it("makes one chunk per section with a heading path and stable keys", () => {
    expect(chunks.map((c) => c.section)).toEqual([
      "Overview",
      "General rules",
      "Paid refunds",
      "Paid refunds > Enterprise credits",
      "Paid refunds > Enterprise only",
    ]);
    expect(chunks.map((c) => c.chunkKey)).toEqual(["sample#0", "sample#1", "sample#2", "sample#3", "sample#4"]);
  });

  it("narrows tiers per section and inherits them into subsections", () => {
    const tiers = Object.fromEntries(chunks.map((c) => [c.section, c.tiers]));
    expect(tiers["General rules"]).toEqual(["free", "pro", "enterprise"]);
    expect(tiers["Paid refunds"]).toEqual(["pro", "enterprise"]);
    expect(tiers["Paid refunds > Enterprise credits"]).toEqual(["pro", "enterprise"]);
    expect(tiers["Paid refunds > Enterprise only"]).toEqual(["enterprise"]);
  });

  it("strips HTML comments and tier tags from chunk text", () => {
    for (const c of chunks) expect(c.content).not.toMatch(/<!--|tiers:/);
  });

  it("rejects section tiers outside the document's tiers", () => {
    const bad = DOC.replace("tiers: [free, pro, enterprise]", "tiers: [free, pro]");
    expect(() => chunkDocument(parsePolicyDoc(bad), OPTS)).toThrow(/not in document tiers/);
  });

  it("splits an oversized section under the cap, with overlap between pieces", () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} explains one refund rule in detail.`);
    const long = `---\nid: long\ntitle: Long\ndoc_type: policy\ntiers: [pro]\n---\n\n## Big section\n\n${sentences.join(" ")}\n`;
    const pieces = chunkDocument(parsePolicyDoc(long), OPTS);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.tokenCount).toBeLessThanOrEqual(OPTS.maxTokens);
      expect(p.section).toBe("Big section");
    }
    // The start of each later piece repeats the end of the previous one.
    const lastSentence = pieces[0].content.split(/(?<=\.)\s+/).pop() ?? "";
    expect(pieces[1].content.startsWith(lastSentence) || pieces[1].content.includes(lastSentence)).toBe(true);
  });

  it("prefixes embedding text with title and section", () => {
    expect(embeddingText(chunks[2])).toMatch(/^Sample Policy > Paid refunds\n\n/);
  });
});

describe("policy corpus", () => {
  it("chunks every document within the cap with unique keys", async () => {
    const all = (await loadCorpus()).flatMap((d) => d.chunks);
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all.map((c) => c.chunkKey)).size).toBe(all.length);
    for (const c of all) expect(c.tokenCount).toBeLessThanOrEqual(CHUNKING.maxTokens);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("scopes tier-specific refund sections", async () => {
    const all = (await loadCorpus()).flatMap((d) => d.chunks);
    const bySection = (s: string) => all.find((c) => c.docId === "refund-policy" && c.section === s)?.tiers;
    expect(bySection("Free tier refunds")).toEqual(["free"]);
    expect(bySection("Pro tier refunds")).toEqual(["pro"]);
    expect(bySection("Enterprise tier refunds and service credits")).toEqual(["enterprise"]);
  });

  it("flags only the injected chunk", async () => {
    const flagged = (await loadCorpus())
      .flatMap((d) => d.chunks)
      .filter((c) => scanForInjection(c.content).length > 0)
      .map((c) => c.chunkKey);
    expect(flagged).toEqual(["partner-program-faq#2"]);
  });
});
