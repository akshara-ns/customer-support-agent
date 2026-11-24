/**
 * /api/rag/search: rate limited in every mode (review round 3), and public callers get only sections that
 * apply to every tier with no traces or drafts; tier filtering and traces need the admin key (review round 4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const ADMIN = "test-admin-key-0123456789";

afterEach(() => {
  vi.doUnmock("@/lib/ratelimit");
  vi.doUnmock("@/lib/guardrails/pipeline");
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function route(allowed = true) {
  vi.resetModules();
  vi.stubEnv("ADMIN_KEY", ADMIN);
  const buckets: string[][] = [];
  vi.doMock("@/lib/ratelimit", () => ({
    consumeLimits: async (_r: Request, limits: { bucket: string }[]) => {
      buckets.push(limits.map((l) => l.bucket));
      return { allowed, retryAfterSec: 60, bucket: limits[0].bucket };
    },
    rateLimitedResponse: () => new Response("{}", { status: 429 }),
  }));
  const pipeline = vi.fn(async (opts: { tier?: string; generalOnly?: boolean }) => ({
    decision: { escalate: true, reason: "low_retrieval_confidence", confidence: 0.2, evidence: [], detail: "" },
    answer: null,
    draft: "draft text",
    retrieval: { chunks: [], confidence: { topScore: 0.2, margin: 0, pass: false } },
    grounding: null,
    trace: { turnId: "t", totals: () => ({}), spans: [{ name: "prompt" }] },
    opts,
  }));
  vi.doMock("@/lib/guardrails/pipeline", () => ({ answerWithGuardrails: pipeline }));
  const { GET } = await import("@/app/api/rag/search/route");
  return { GET, buckets, pipeline };
}

const req = (qs: string, key?: string) => new Request(`http://x/api/rag/search?${qs}`, { headers: key ? { "x-admin-key": key } : {} });

describe("GET /api/rag/search rate limit", () => {
  it("retrieval-only mode is limited too, before any retrieval runs", async () => {
    const { GET, buckets, pipeline } = await route(false);
    expect((await GET(req("q=refund+window"))).status).toBe(429);
    expect(buckets[0]).toEqual(["rag_search:ip", "rag_search:daily"]);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("answer=1 adds the tighter LLM limits", async () => {
    const { GET, buckets } = await route(false);
    await GET(req("q=refund+window&answer=1"));
    expect(buckets[0]).toEqual(["rag_search:ip", "rag_search:daily", "rag_answer:ip", "rag_answer:daily"]);
  });
});

describe("GET /api/rag/search access", () => {
  it("public: searches only sections for every tier and returns no trace, draft or grounding", async () => {
    const { GET, pipeline } = await route();
    const res = await GET(req("q=refund+window"));
    expect(res.status).toBe(200);
    expect(pipeline.mock.calls[0][0]).toMatchObject({ generalOnly: true, tier: undefined });
    const body = await res.json();
    expect(body.scope).toBe("sections for every tier");
    expect(body.trace).toBeUndefined();
    expect(body.draft).toBeUndefined();
  });

  it("public: a tier filter is refused (403) without the admin key, or with a wrong one", async () => {
    const { GET, pipeline } = await route();
    expect((await GET(req("q=refund+window&tier=pro"))).status).toBe(403);
    expect((await GET(req("q=refund+window&tier=pro", "wrong-key-0123456789"))).status).toBe(403);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("admin: tier filter and full trace", async () => {
    const { GET, pipeline } = await route();
    const res = await GET(req("q=refund+window&tier=pro", ADMIN));
    expect(res.status).toBe(200);
    expect(pipeline.mock.calls[0][0]).toMatchObject({ generalOnly: false, tier: "pro" });
    const body = await res.json();
    expect(body.trace.spans).toHaveLength(1);
    expect(body.draft).toBe("draft text");
  });
});
