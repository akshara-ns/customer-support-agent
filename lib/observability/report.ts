/**
 * Turns trace rows into what the observability drawer shows: per turn a span tree, latency
 * (TTFT, end to end, per tool), tokens, estimated cost, guardrail decisions, claim-check
 * corrections and retries; per session p50/p95 and totals. Pure, so it is unit-tested.
 */
import type { TraceRow } from "@/lib/observability/pg-traces";
import type { Channel, SpanKind } from "@/lib/types";

export interface SpanNode {
  id: string;
  kind: SpanKind;
  name: string;
  status: "ok" | "error";
  startMs: number;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  costUsd: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  children: SpanNode[];
}

export interface TurnReport {
  turnId: string;
  channel: Channel;
  startedAt: string;
  durationMs: number;
  ttftMs: number | null;
  state: string | null;
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
  tools: { name: string; durationMs: number; status: string; error?: string }[];
  guardrails: { name: string; detail: unknown }[];
  corrections: unknown[];
  retries: unknown[];
  spans: SpanNode[];
}

export interface SessionReport {
  turns: TurnReport[];
  summary: {
    turns: number;
    chatTurnMs: { p50: number | null; p95: number | null };
    ttftMs: { p50: number | null; p95: number | null };
    voiceResponseMs: { p50: number | null; p95: number | null };
    tokens: { in: number; out: number; cached: number };
    costUsd: { chat: number; voice: number; total: number };
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
/** The Neon driver returns timestamptz as a Date; Date.parse(date) would drop milliseconds. */
const toMs = (v: string | Date) => (v instanceof Date ? v.getTime() : Date.parse(v));

export function buildReport(rows: TraceRow[]): SessionReport {
  const byTurn = new Map<string, TraceRow[]>();
  for (const r of rows) byTurn.set(r.turn_id, [...(byTurn.get(r.turn_id) ?? []), r]);

  const turns: TurnReport[] = [];
  const voiceLatencies: number[] = [];
  for (const [turnId, list] of byTurn) {
    const t0 = Math.min(...list.map((r) => toMs(r.started_at)));
    const end = Math.max(...list.map((r) => toMs(r.started_at) + r.duration_ms));
    const nodes = new Map<string, SpanNode>();
    for (const r of list) {
      nodes.set(r.id, {
        id: r.id,
        kind: r.kind,
        name: r.name,
        status: r.status,
        startMs: toMs(r.started_at) - t0,
        durationMs: r.duration_ms,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        tokensCached: r.tokens_cached,
        costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
        input: r.input,
        output: r.output,
        error: r.error,
        children: [],
      });
    }
    const roots: SpanNode[] = [];
    for (const r of list) {
      const n = nodes.get(r.id)!;
      const parent = r.parent_id ? nodes.get(r.parent_id) : undefined;
      if (parent) parent.children.push(n);
      else roots.push(n);
    }
    const sortTree = (ns: SpanNode[]) => {
      ns.sort((a, b) => a.startMs - b.startMs);
      ns.forEach((n) => sortTree(n.children));
    };
    sortTree(roots);

    const out = (name: string) => list.find((r) => r.name === name)?.output as Record<string, unknown> | undefined;
    const realtime = list.filter((r) => r.name.startsWith("realtime_response"));
    for (const r of realtime) {
      const ms = (r.output as { latencyMs?: number } | null)?.latencyMs;
      if (typeof ms === "number") voiceLatencies.push(ms);
    }
    const voiceTtft = realtime.map((r) => (r.output as { latencyMs?: number } | null)?.latencyMs).filter((v): v is number => typeof v === "number");
    turns.push({
      turnId,
      channel: list.some((r) => r.channel === "voice") ? "voice" : "chat",
      startedAt: new Date(t0).toISOString(),
      durationMs: end - t0,
      ttftMs: (out("first_token")?.ms as number | undefined) ?? (voiceTtft.length ? Math.min(...voiceTtft) : null),
      state: (out("turn_end")?.state as string | undefined) ?? null,
      tokens: {
        in: list.reduce((a, r) => a + num(r.tokens_in), 0),
        out: list.reduce((a, r) => a + num(r.tokens_out), 0),
        cached: list.reduce((a, r) => a + num(r.tokens_cached), 0),
      },
      costUsd: list.reduce((a, r) => a + num(r.cost_usd), 0),
      tools: list
        .filter((r) => r.kind === "tool")
        .map((r) => ({ name: r.name, durationMs: r.duration_ms, status: r.status, error: (r.output as { error?: { code?: string } } | null)?.error?.code })),
      guardrails: list.filter((r) => r.kind === "guardrail").map((r) => ({ name: r.name, detail: r.output })),
      corrections: list.filter((r) => r.name === "claim_check").map((r) => r.output),
      retries: list.filter((r) => r.name === "retry").map((r) => r.output),
      spans: roots,
    });
  }
  turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const chatTurns = turns.filter((t) => t.channel === "chat");
  const cost = (ch: Channel) => turns.filter((t) => t.channel === ch).reduce((a, t) => a + t.costUsd, 0);
  return {
    turns,
    summary: {
      turns: turns.length,
      chatTurnMs: { p50: percentile(chatTurns.map((t) => t.durationMs), 50), p95: percentile(chatTurns.map((t) => t.durationMs), 95) },
      ttftMs: {
        p50: percentile(chatTurns.map((t) => t.ttftMs).filter((v): v is number => v !== null), 50),
        p95: percentile(chatTurns.map((t) => t.ttftMs).filter((v): v is number => v !== null), 95),
      },
      voiceResponseMs: { p50: percentile(voiceLatencies, 50), p95: percentile(voiceLatencies, 95) },
      tokens: {
        in: turns.reduce((a, t) => a + t.tokens.in, 0),
        out: turns.reduce((a, t) => a + t.tokens.out, 0),
        cached: turns.reduce((a, t) => a + t.tokens.cached, 0),
      },
      costUsd: { chat: cost("chat"), voice: cost("voice"), total: cost("chat") + cost("voice") },
    },
  };
}
