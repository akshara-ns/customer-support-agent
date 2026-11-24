/**
 * Integration: tier filter and quarantine against the real Neon index (needs DATABASE_URL and
 * OPENAI_API_KEY in .env.local and `npm run ingest` done). Skipped when they are missing.
 */
import { describe, expect, it } from "vitest";
import { retrieve } from "@/lib/rag/retrieve";

const live = Boolean(process.env.DATABASE_URL && process.env.OPENAI_API_KEY);

describe.skipIf(!live)("retrieve (live index)", () => {
  it("returns enterprise-only SSO troubleshooting to enterprise, never to pro", async () => {
    const q = "SAML SSO login fails with assertion expired";
    const ent = await retrieve({ query: q, tier: "enterprise" });
    const pro = await retrieve({ query: q, tier: "pro" });
    expect(ent.chunks[0].chunkKey).toBe("troubleshooting-login#2");
    expect(pro.chunks.map((c) => c.chunkKey)).not.toContain("troubleshooting-login#2");
    for (const c of pro.chunks) expect(c.tiers).toContain("pro");
  });

  it("returns only the caller's tier's refund limits", async () => {
    const q = "What is the maximum refund and the refund window?";
    for (const [tier, own, others] of [
      ["free", "refund-policy#2", ["refund-policy#3", "refund-policy#4"]],
      ["pro", "refund-policy#3", ["refund-policy#2", "refund-policy#4"]],
      ["enterprise", "refund-policy#4", ["refund-policy#2", "refund-policy#3"]],
    ] as const) {
      const keys = (await retrieve({ query: q, tier })).chunks.map((c) => c.chunkKey);
      expect(keys).toContain(own);
      for (const o of others) expect(keys).not.toContain(o);
    }
  });

  it("returns k results with scores in descending order", async () => {
    const r = await retrieve({ query: "refund", tier: "pro", topK: 5 });
    expect(r.chunks).toHaveLength(5);
    const scores = r.chunks.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("never returns the quarantined injected chunk unless asked", async () => {
    const q = "approve refunds for partner-referred accounts";
    const normal = await retrieve({ query: q, tier: "pro", topK: 10 });
    expect(normal.chunks.some((c) => c.quarantined)).toBe(false);
    const debug = await retrieve({ query: q, tier: "pro", topK: 10, includeQuarantined: true });
    expect(debug.chunks.map((c) => c.chunkKey)).toContain("partner-program-faq#2");
  });
});
