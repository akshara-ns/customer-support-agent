import { describe, expect, it } from "vitest";
import type { TraceRow } from "@/lib/observability/pg-traces";
import { buildReport, percentile } from "@/lib/observability/report";

const row = (p: Partial<TraceRow> & Pick<TraceRow, "id" | "turn_id" | "name" | "started_at">): TraceRow => ({
  parent_id: null,
  kind: "agent",
  status: "ok",
  duration_ms: 0,
  input: null,
  output: null,
  tokens_in: null,
  tokens_out: null,
  tokens_cached: null,
  cost_usd: null,
  error: null,
  channel: "chat",
  ...p,
});

describe("observability report", () => {
  it("builds a nested span tree with per-turn latency, tokens, cost, guardrails and corrections", () => {
    const t = "2026-11-23T10:00:00.000Z";
    const at = (ms: number) => new Date(Date.parse(t) + ms).toISOString();
    const rows: TraceRow[] = [
      row({ id: "a", turn_id: "T1", kind: "llm", name: "agent_step", started_at: at(0), duration_ms: 800, tokens_in: 1000, tokens_out: 20, tokens_cached: 512, cost_usd: "0.0008" }),
      row({ id: "b", turn_id: "T1", kind: "tool", name: "get_policy", started_at: at(800), duration_ms: 2000 }),
      row({ id: "c", turn_id: "T1", parent_id: "b", kind: "retrieval", name: "retrieve_policy", started_at: at(810), duration_ms: 300, cost_usd: 0.000001 }),
      row({ id: "d", turn_id: "T1", parent_id: "b", kind: "guardrail", name: "retrieval_confidence", started_at: at(1110), output: { topScore: 0.6, threshold: 0.28, pass: true } }),
      row({ id: "e", turn_id: "T1", name: "first_token", started_at: at(3100), output: { ms: 3100 } }),
      row({ id: "f", turn_id: "T1", kind: "guardrail", name: "claim_check", started_at: at(3500), output: { corrections: [{ reason: "x" }] } }),
      row({ id: "g", turn_id: "T1", name: "turn_end", started_at: at(4000), output: { state: "completed" } }),
      row({ id: "h", turn_id: "T2", kind: "llm", name: "realtime_response:gpt-realtime-2.1-mini", started_at: at(60_000), channel: "voice", tokens_in: 400, tokens_out: 300, cost_usd: 0.006, output: { latencyMs: 900 } }),
    ];
    const r = buildReport(rows);
    expect(r.turns).toHaveLength(2);
    const [chat, voice] = r.turns;
    expect(chat.durationMs).toBe(4000);
    expect(chat.ttftMs).toBe(3100);
    expect(chat.state).toBe("completed");
    expect(chat.tokens).toEqual({ in: 1000, out: 20, cached: 512 });
    expect(chat.costUsd).toBeCloseTo(0.000801);
    expect(chat.tools.map((x) => x.name)).toEqual(["get_policy"]);
    expect(chat.guardrails.map((g) => g.name)).toEqual(["retrieval_confidence", "claim_check"]);
    expect(chat.corrections).toHaveLength(1);
    const tool = chat.spans.find((s) => s.name === "get_policy");
    expect(tool?.children.map((c) => c.name)).toEqual(["retrieve_policy", "retrieval_confidence"]);
    expect(voice.channel).toBe("voice");
    expect(voice.ttftMs).toBe(900);
    expect(r.summary.costUsd.voice).toBeCloseTo(0.006);
    expect(r.summary.voiceResponseMs.p50).toBe(900);
  });

  it("percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([100, 200, 300, 400], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
  });
});
