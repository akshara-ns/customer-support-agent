/**
 * Unverified tier-specific questions ask for verification instead of escalating (review round 4, grader):
 * the general-only search escalates, a retrieval-only check across tiers decides whether the answer
 * is in tier-specific sections. Fake pipeline, no API cost.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import type { answerWithGuardrails } from "@/lib/guardrails/pipeline";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { policySearchWith } from "@/lib/tools/policy-search";
import type { AgentEvent, Tier } from "@/lib/types";

type Opts = Parameters<typeof answerWithGuardrails>[0];

/** Fake pipeline: the general-only search escalates; the all-tier retrieval passes or not, with the given top-chunk tiers. */
function pipeline(allTierPass: boolean, topTiers: Tier[]) {
  return vi.fn(async (o: Opts) => {
    const escalate = o.generalOnly || !allTierPass;
    return {
      decision: escalate
        ? { escalate: true as const, reason: "answer_declined" as const, confidence: 0.6, evidence: [], detail: "" }
        : { escalate: false as const, confidence: 0.6, evidence: [] },
      answer: null,
      draft: null,
      retrieval: { chunks: [{ chunkKey: "refund-policy#3", tiers: topTiers }], confidence: { topScore: 0.6, margin: 0.1, pass: true } },
      grounding: null,
      trace: {},
    };
  }) as unknown as typeof answerWithGuardrails & ReturnType<typeof vi.fn>;
}

describe("policy search before verification", () => {
  it("asks to verify when the answer is in tier-specific sections", async () => {
    const p = pipeline(true, ["pro"]);
    const r = await policySearchWith(p).search("What's the refund limit on the Pro plan?", null);
    expect(r).toMatchObject({ status: "needs_verification", reason: "tier_specific", tiers: ["pro"] });
    expect(p.mock.calls[1][0]).toMatchObject({ generate: false }); // the second check makes no LLM call
  });

  it("still escalates when nothing passes the threshold across tiers (out of scope)", async () => {
    const r = await policySearchWith(pipeline(false, ["pro"])).search("Recommend a stock", null);
    expect(r.status).toBe("needs_escalation");
  });

  it("still escalates when the best match applies to every tier (verification wouldn't change the answer)", async () => {
    const r = await policySearchWith(pipeline(true, ["free", "pro", "enterprise"])).search("Something general", null);
    expect(r.status).toBe("needs_escalation");
  });

  it("verified customers never get needs_verification", async () => {
    const p = pipeline(true, ["pro"]);
    const r = await policySearchWith(p).search("q", "pro");
    expect(r.status).toBe("needs_escalation"); // the fake returns no answer for the tier search
    expect(p).toHaveBeenCalledTimes(1);
  });
});

describe("agent turn with needs_verification", () => {
  it("is not an escalation: no escalation event, turn completes, the model is told to ask for email and PIN", async () => {
    const steps: ModelTurn[] = [
      { content: "", toolCalls: [{ id: "c1", name: "get_policy", arguments: JSON.stringify({ question: "Pro refund limit?" }) }], usage: { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 } },
      { content: "That depends on your plan. What's your email and support PIN? ", toolCalls: [], usage: { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 } },
    ];
    let i = 0;
    const model: AgentModel = { name: "s", complete: async (_r, onText) => { const t = steps[i++]; if (t.content) onText(t.content); return t; } };
    const events = new MemoryEventStore();
    const now = new Date("2026-11-23T12:00:00Z");
    const tools = { customers: customerDirectory(now), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: policySearchWith(pipeline(true, ["pro"])), now: () => now };
    const emitted: AgentEvent[] = [];
    const r = await runTurn({ sessionId: "s-vf", message: "Pro refund limit?", channel: "chat" }, { model, events, tools }, (e) => emitted.push(e));
    expect(r.state).toBe("completed");
    expect(emitted.some((e) => e.type === "escalation")).toBe(false);
    const result = (await events.list("s-vf")).map((e) => e.event).find((e) => e.type === "tool_result");
    expect(JSON.stringify(result)).toContain("support PIN");
  });
});

describe("unverified questions about the customer's own plan (generic wording)", () => {
  it("asks to verify even when the best match applies to every tier", async () => {
    // The agent rewrites the question before get_policy, often in the third person ("the customer's plan").
    for (const q of ["What's my refund limit?", "How long do I have to request a refund?", "What does my plan include?", "What is the refund limit for the customer's plan?", "What does their plan include?", "What is your refund window?"]) {
      const r = await policySearchWith(pipeline(true, ["free", "pro", "enterprise"])).search(q, null);
      expect(r.status, q).toBe("needs_verification");
    }
  });

  it("still escalates off-topic questions, possessive or not, when nothing relevant is retrieved", async () => {
    for (const q of ["Can you recommend a good stock to buy?", "What's my favourite stock right now?"]) {
      const r = await policySearchWith(pipeline(false, ["free", "pro", "enterprise"])).search(q, null);
      expect(r.status, q).toBe("needs_escalation");
    }
  });

  it("a general how-to question with an every-tier answer still escalates when the general search did", async () => {
    const r = await policySearchWith(pipeline(true, ["free", "pro", "enterprise"])).search("How does data export work?", null);
    expect(r.status).toBe("needs_escalation");
  });
});

