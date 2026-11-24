/** /api/rag/search is rate limited in every mode, not only answer=1 (grader, Phase 7). */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@/lib/ratelimit");
  vi.doUnmock("@/lib/guardrails/pipeline");
  vi.resetModules();
});

async function route(allowed: boolean) {
  vi.resetModules();
  const buckets: string[][] = [];
  vi.doMock("@/lib/ratelimit", () => ({
    consumeLimits: async (_r: Request, limits: { bucket: string }[]) => {
      buckets.push(limits.map((l) => l.bucket));
      return { allowed, retryAfterSec: 60, bucket: limits[0].bucket };
    },
    rateLimitedResponse: () => new Response("{}", { status: 429 }),
  }));
  const pipeline = vi.fn(async () => {
    throw new Error("not reached in this test");
  });
  vi.doMock("@/lib/guardrails/pipeline", () => ({ answerWithGuardrails: pipeline }));
  const { GET } = await import("@/app/api/rag/search/route");
  return { GET, buckets, pipeline };
}

describe("GET /api/rag/search rate limit", () => {
  it("retrieval-only mode is limited too, before any retrieval runs", async () => {
    const { GET, buckets, pipeline } = await route(false);
    const res = await GET(new Request("http://x/api/rag/search?q=refund+window&tier=pro"));
    expect(res.status).toBe(429);
    expect(buckets[0]).toEqual(["rag_search:ip", "rag_search:daily"]);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("answer=1 adds the tighter LLM limits", async () => {
    const { GET, buckets } = await route(false);
    await GET(new Request("http://x/api/rag/search?q=refund+window&tier=pro&answer=1"));
    expect(buckets[0]).toEqual(["rag_search:ip", "rag_search:daily", "rag_answer:ip", "rag_answer:daily"]);
  });
});
