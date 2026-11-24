/**
 * Final-reply grounding (senior review + Phase 9 open item): the text the customer sees must be backed by
 * this conversation's tool records. An ungrounded reply with no policy lookup this turn goes through the
 * guardrail in code, so "recommend a stock" reaches the escalated state whatever the model chose to do.
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import type { FinalReplyChecker } from "@/lib/guardrails/final-reply";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { PolicySearch } from "@/lib/tools/stores";
import type { AgentEvent } from "@/lib/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };
const text = (content: string): ModelTurn => ({ content, toolCalls: [], usage });
const tool = (name: string, args: object): ModelTurn => ({ content: "", toolCalls: [{ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args) }], usage });
const VERIFY = tool("verify_identity", { email: "omar@example.com", code: "715204" });

/** Flags sentences mentioning stocks/investing or "free month" as unsupported; everything else supported. */
const fakeChecker: FinalReplyChecker = async (reply) => {
  const unsupported = (reply.match(/[^.!?]*(stock|invest|free month)[^.!?]*[.!?]/gi) ?? []).map((s) => s.trim());
  return { claims: unsupported.map((claim) => ({ claim, supported: false })), unsupported, ok: unsupported.length === 0 };
};

const policy: PolicySearch = {
  search: async (q) =>
    /refund/i.test(q)
      ? { status: "answered", answer: "Pro refunds are up to $200 within 30 days [refund-policy#3].", citations: ["refund-policy#3"], confidence: 0.6 }
      : { status: "needs_escalation", reason: "low_retrieval_confidence", confidence: 0.18 },
};

function session() {
  const events = new MemoryEventStore();
  const tickets = new MemoryTickets();
  const tools = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets, policy, now: () => NOW };
  const turn = async (message: string, steps: ModelTurn[]) => {
    let i = 0;
    const model: AgentModel = { name: "s", complete: async (_r, onText) => { const t = steps[i++] ?? text("Done. "); if (t.content) onText(t.content); return t; } };
    const emitted: AgentEvent[] = [];
    const r = await runTurn({ sessionId: "s-fg", message, channel: "chat" }, { model, events, tools, finalChecker: fakeChecker }, (e) => emitted.push(e));
    const shown = emitted.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
    return { r, emitted, shown };
  };
  return { turn, tickets };
}

const DECLINE = "I can't give stock picks, but I can help you with a general framework for evaluating a stock.";

describe("final-reply grounding", () => {
  it("fresh verified session: an off-topic reply without a tool goes through the guardrail and ends escalated with a ticket", async () => {
    const s = session();
    await s.turn("omar@example.com 715204", [VERIFY, text("You're verified. ")]);
    const { r, emitted, shown } = await s.turn("Can you recommend a good stock to buy?", [text(DECLINE)]);
    expect(r.toolsCalled).toEqual(["get_policy"]); // run by code, not chosen by the model
    expect(r.state).toBe("escalated");
    expect(shown).not.toContain("framework");
    expect(shown).toMatch(/handed it to a person: ticket ESC-\d+/);
    expect(emitted.find((e) => e.type === "escalation")).toMatchObject({ kind: "ticket", reason: "low_retrieval_confidence" });
    expect(r.trace.spans.map((x) => x.name)).toEqual(expect.arrayContaining(["final_grounding", "final_reply_replaced"]));
  });

  it("post-handoff session: the same question still reaches the escalated state via the guardrail", async () => {
    const s = session();
    await s.turn("omar@example.com 715204", [VERIFY, text("You're verified. ")]);
    await s.turn("I want a person", [tool("create_escalation_ticket", { reason: "customer_request", summary: "wants a person" }), text("Ticket opened. ")]);
    const { r } = await s.turn("Can you recommend a good stock to buy?", [text(DECLINE)]);
    expect(r.toolsCalled).toEqual(["get_policy"]);
    expect(r.state).toBe("escalated");
  });

  it("policy lookup this turn: an unsupported extra sentence is removed, the grounded part stays", async () => {
    const s = session();
    await s.turn("omar@example.com 715204", [VERIFY, text("You're verified. ")]);
    const { r, shown } = await s.turn("What's my refund limit?", [
      tool("get_policy", { question: "What is the Pro refund limit?" }),
      text("Pro refunds are up to $200 within 30 days. Annual plans also get a free month of storage. "),
    ]);
    expect(shown).toContain("up to $200 within 30 days");
    expect(shown).not.toContain("free month");
    expect(shown).toContain("couldn't confirm anything beyond that");
    expect(r.state).toBe("completed");
  });

  it("a grounded reply is released unchanged", async () => {
    const s = session();
    const { shown, r } = await s.turn("hi", [text("Hi! What can I help you with today? ")]);
    expect(shown).toBe("Hi! What can I help you with today? ");
    expect(r.toolsCalled).toEqual([]);
  });

  it("action-tool turns are not escalated by the checker (paraphrases of tool results are only logged)", async () => {
    const s = session();
    const { r, shown } = await s.turn("omar@example.com 715204", [VERIFY, text("You're verified. I can help with stock questions too. ")]);
    expect(r.toolsCalled).toEqual(["verify_identity"]);
    expect(r.state).toBe("completed");
    expect(shown).toContain("You're verified.");
    expect(r.trace.spans.map((x) => x.name)).toContain("final_grounding_advisory");
  });
});
