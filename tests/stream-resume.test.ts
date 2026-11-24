/**
 * Stream-resume protocol: SSE framing across chunk boundaries, de-duplication across the original
 * and resumed streams (no duplicates, no gaps), and the resume endpoint (replay after N, follow to
 * `done`, ownership and unknown-stream checks) with the stream log and ownership mocked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeqTracker, readSse } from "@/components/sse";
import type { SseEvent } from "@/lib/types";

const tok = (seq: number, text: string): SseEvent => ({ type: "token", text, seq });
const done = (seq: number): SseEvent => ({ type: "done", turnId: "t", state: "completed", totals: { durationMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0 }, seq });
const frame = (e: SseEvent) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const e of readSse(body)) out.push(e);
  return out;
}

describe("SSE framing", () => {
  it("parses frames split at arbitrary byte boundaries", async () => {
    const text = [tok(1, "Hello "), tok(2, "there. "), done(3)].map(frame).join("");
    const chunks = text.match(/[\s\S]{1,7}/g) ?? [];
    expect((await collect(streamOf(chunks))).map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe("resume de-duplication", () => {
  it("original stream drops after 2; resume replays from the server's log; result has no gaps or duplicates", () => {
    const seen = createSeqTracker();
    const applied: number[] = [];
    for (const e of [tok(1, "a"), tok(2, "b")]) if (seen.accept(e)) applied.push(e.seq);
    expect(seen.last).toBe(2); // the client resumes with after=2
    // The server replays seq > after, but a racing replay may also repeat an earlier event.
    for (const e of [tok(2, "b"), tok(3, "c"), tok(4, "d"), done(5)]) if (seen.accept(e)) applied.push(e.seq);
    expect(applied).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("GET /api/chat/stream", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/session/stream-log");
    vi.doUnmock("@/lib/session/owner");
    vi.resetModules();
  });

  async function route(opts: { batches: SseEvent[][]; session?: string | null; owner?: boolean }) {
    vi.resetModules();
    const calls: number[] = [];
    let i = 0;
    vi.doMock("@/lib/session/stream-log", () => ({
      readStreamEvents: async (_id: string, after: number) => {
        calls.push(after);
        return (opts.batches[i++] ?? []).filter((e) => e.seq > after);
      },
    }));
    vi.doMock("@/lib/session/owner", () => ({
      sessionOfStream: async () => (opts.session === undefined ? "11111111-1111-4111-8111-111111111111" : opts.session),
      authorizeSession: async () => opts.owner ?? true,
      ownerFromRequest: () => ({ hash: "h", setCookie: null }),
    }));
    const { GET } = await import("@/app/api/chat/stream/route");
    return { GET, calls };
  }

  const url = (after: number) => `http://x/api/chat/stream?streamId=22222222-2222-4222-8222-222222222222&after=${after}`;

  it("replays events after N, keeps following until done, then closes", async () => {
    const { GET, calls } = await route({ batches: [[tok(3, "c"), tok(4, "d")], [], [tok(5, "e"), done(6)]] });
    const res = await GET(new Request(url(2)));
    expect(res.status).toBe(200);
    const events = await collect(res.body!);
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(calls).toEqual([2, 4, 4]); // polls with the last seq it sent
  });

  it("refuses another browser's stream and unknown streams", async () => {
    const forbidden = await route({ batches: [], owner: false });
    expect((await forbidden.GET(new Request(url(0)))).status).toBe(403);
    const unknown = await route({ batches: [], session: null });
    expect((await unknown.GET(new Request(url(0)))).status).toBe(404);
  });

  it("rejects a malformed request", async () => {
    const { GET } = await route({ batches: [] });
    expect((await GET(new Request("http://x/api/chat/stream?streamId=nope&after=-1"))).status).toBe(400);
  });
});
