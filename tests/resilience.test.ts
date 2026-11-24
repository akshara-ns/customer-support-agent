/**
 * Failure modes, scripted: LLM 429 (retried, honouring Retry-After), LLM timeout (fallback),
 * no retry once text streamed, tool failure mid-chain (recorded, then exactly one refund on
 * retry), retrieval unavailable, plus backoff and redaction units.
 */
import { describe, expect, it } from "vitest";
import { ModelError, type AgentModel, type ModelTurn } from "@/lib/agent/model";
import { backoffMs } from "@/lib/agent/retry";
import { runTurn } from "@/lib/agent/run";
import { runWithFault } from "@/lib/faults";
import { redact, redactText } from "@/lib/observability/redact";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { PolicySearch } from "@/lib/tools/stores";
import type { AgentEvent } from "@/lib/types";

const NOW = new Date("2026-11-23T12:00:00Z");
type Step = ModelTurn | (() => never) | { text: string; thenThrow: ModelError };
const turn = (content: string, call?: { name: string; args: unknown }): ModelTurn => ({
  content,
  toolCalls: call ? [{ id: `c_${Math.random().toString(36).slice(2, 8)}`, name: call.name, arguments: JSON.stringify(call.args) }] : [],
  usage: { model: "scripted", tokensIn: 10, tokensOut: 5, cachedTokens: 0 },
});

function scripted(steps: Step[]): AgentModel & { calls: number } {
  const m = {
    name: "scripted",
    calls: 0,
    async complete(_req: unknown, onText: (d: string) => void): Promise<ModelTurn> {
      const step = steps[m.calls++] ?? turn("Done.");
      if (typeof step === "function") step();
      if ("thenThrow" in step) {
        onText(step.text);
        throw step.thenThrow;
      }
      for (const piece of (step as ModelTurn).content.match(/[\s\S]{1,8}/g) ?? []) onText(piece);
      return step as ModelTurn;
    },
  };
  return m;
}

const okPolicy: PolicySearch = {
  search: async () => ({ status: "answered", answer: "Pro refunds: up to $200 within 30 days [refund-policy#3].", citations: ["refund-policy#3"], confidence: 0.6 }),
};

function setup(steps: Step[], policy: PolicySearch = okPolicy) {
  const ledger = new MemoryLedger();
  const events = new MemoryEventStore();
  const delays: number[] = [];
  const model = scripted(steps);
  const deps = {
    model,
    events,
    tools: { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy, now: () => NOW },
    sleep: async (ms: number) => void delays.push(ms),
  };
  const emitted: AgentEvent[] = [];
  const say = (message: string) => runTurn({ sessionId: "s-res", message, channel: "chat" }, deps, (e) => emitted.push(e));
  return { ledger, events, emitted, delays, model, say };
}

const rateLimited = () => {
  throw new ModelError("llm_rate_limited", "rate limited", 1000);
};
const timedOut = () => {
  throw new ModelError("llm_timeout", "timed out");
};
const VERIFY = { name: "verify_identity", args: { email: "omar@example.com", code: "715204" } };
const REFUND = { name: "issue_refund", args: { invoice_id: "inv_2004", amount_usd: 29, reason: "extra seat" } };

describe("LLM failures", () => {
  it("429 twice: retries after Retry-After, shows 'retrying', then answers normally", async () => {
    const s = setup([rateLimited, rateLimited, turn("Hello! How can I help?")]);
    const r = await s.say("hi");
    expect(r.state).toBe("completed");
    expect(r.reply).toBe("Hello! How can I help?");
    expect(s.delays).toEqual([1000, 1000]); // honoured Retry-After: 1
    const retrying = s.emitted.filter((e) => e.type === "retrying");
    expect(retrying.map((e) => (e as { attempt: number }).attempt)).toEqual([2, 3]);
    expect(s.emitted.some((e) => e.type === "error")).toBe(false);
  });

  it("timeout on every attempt: 3 attempts with backoff, typed error, friendly fallback, then the next turn works", async () => {
    const s = setup([timedOut, timedOut, timedOut, turn("I'm back. What do you need?")]);
    const r = await s.say("hi");
    expect(s.model.calls).toBe(3);
    expect(s.delays).toHaveLength(2);
    expect(s.delays[1]).toBeGreaterThan(s.delays[0] * 0.9);
    expect(r.state).toBe("failed");
    expect(s.emitted.find((e) => e.type === "error")).toMatchObject({ code: "llm_timeout", retryable: true });
    expect(r.reply).toMatch(/took too long.*Nothing was changed/);
    expect(s.emitted.at(-1)).toMatchObject({ type: "done", state: "failed" });
    const next = await s.say("hello again");
    expect(next.state).toBe("completed");
  });

  it("never retries once part of the reply has been streamed (no duplicated text)", async () => {
    const s = setup([{ text: "Sure, let me explain. ", thenThrow: new ModelError("llm_unavailable", "down") }, turn("SHOULD NOT APPEAR")]);
    const r = await s.say("hi");
    expect(s.model.calls).toBe(1);
    expect(s.emitted.some((e) => e.type === "retrying")).toBe(false);
    expect(r.reply).not.toContain("SHOULD NOT APPEAR");
    expect(r.reply.match(/Sure, let me explain/g)).toHaveLength(1);
  });
});

describe("tool failure mid-chain", () => {
  it("refund fails after the request is recorded; the retry with the same key issues exactly one refund", async () => {
    const s = setup([
      turn("", VERIFY),
      turn("", { name: "get_policy", args: { question: "refund limit on my plan?" } }),
      turn("", REFUND),
      turn("I couldn't complete the refund; nothing was refunded. Want me to try again?"),
      turn("", REFUND),
      turn("Your refund of $29 has been issued."),
    ]);
    const first = await runWithFault("tool_failure", () => s.say("omar@example.com 715204, refund the $29 seat charge"));
    expect(first.toolsCalled).toEqual(["verify_identity", "get_policy", "issue_refund"]);
    expect(first.actions.refunds).toHaveLength(0);
    expect(s.emitted.find((e) => e.type === "error")).toMatchObject({ code: "tool_failed", tool: "issue_refund" });
    const entries = [...s.ledger.entries.values()];
    expect(entries.map((e) => e.status)).toEqual(["pending"]); // recorded, never acknowledged

    // The session log shows exactly what happened.
    const log = (await s.events.list("s-res")).map((e) => e.event);
    const refundResult = log.find((e) => e.type === "tool_result" && e.name === "issue_refund");
    expect(refundResult).toMatchObject({ result: { ok: false, error: { code: "TOOL_FAILURE" } } });
    expect(log.some((e) => e.type === "error" && e.code === "tool_failed")).toBe(true);

    // Next turn: same request, same idempotency key → resumes the pending entry.
    const second = await s.say("Yes, please try again.");
    expect(second.actions.refunds).toHaveLength(1);
    const succeeded = [...s.ledger.entries.values()].filter((e) => e.status === "succeeded");
    expect(succeeded).toHaveLength(1);
    expect(s.ledger.entries.size).toBe(1);
    expect(second.corrections).toEqual([]);
  });

  it("retrieval unavailable: typed SERVICE_UNAVAILABLE, its own error event, conversation continues", async () => {
    const down: PolicySearch = {
      search: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      },
    };
    const s = setup([turn("", { name: "get_policy", args: { question: "refund window?" } }), turn("The knowledge base is unavailable right now.")], down);
    const r = await s.say("what's the refund window?");
    expect(r.state).toBe("completed");
    expect(s.emitted.find((e) => e.type === "error")).toMatchObject({ code: "retrieval_unavailable" });
    const result = (await s.events.list("s-res")).map((e) => e.event).find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ result: { ok: false, error: { code: "SERVICE_UNAVAILABLE" } } });
  });
});

describe("units", () => {
  it("backoff: exponential with equal jitter, capped, Retry-After wins", () => {
    const o = { baseMs: 400, maxMs: 4000 };
    expect(backoffMs(1, o, undefined, () => 0)).toBe(200);
    expect(backoffMs(1, o, undefined, () => 1)).toBe(400);
    expect(backoffMs(3, o, undefined, () => 1)).toBe(1600);
    expect(backoffMs(10, o, undefined, () => 1)).toBe(4000);
    expect(backoffMs(1, o, 1000, () => 0)).toBe(1000);
  });

  it("redacts secrets, emails and PINs, and sensitive keys", () => {
    expect(redactText("omar@example.com PIN 715204, $174.00, key sk-abcdefghijkl")).toBe("o***@example.com PIN [pin], $174.00, key [secret]");
    expect(redact({ email: "sam@example.com", code: "559072", error: { code: "TOOL_FAILURE" }, nested: [{ clientSecret: "ek_123456789" }] })).toEqual({
      email: "s***@example.com",
      code: "[pin]",
      error: { code: "TOOL_FAILURE" },
      nested: [{ clientSecret: "[redacted]" }],
    });
  });
});
