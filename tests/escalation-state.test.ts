/**
 * Low-confidence escalation is a real state (brief requirement): when get_policy can't answer reliably,
 * the turn ends "escalated", the escalation carries reason and confidence, and a ticket is opened in
 * code for a verified customer (offered otherwise). Same for voice, which also gets a handoff line.
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { PolicySearch, ToolDeps } from "@/lib/tools/stores";
import type { AgentEvent } from "@/lib/types";
import { runVoiceTool } from "@/lib/voice/bridge";
import { escalationReasonText } from "@/lib/contracts";

const NOW = new Date("2026-11-23T12:00:00Z");
const LOW: PolicySearch = { search: async () => ({ status: "needs_escalation", reason: "low_retrieval_confidence", confidence: 0.214 }) };
const VERIFY = { name: "verify_identity", args: { email: "omar@example.com", code: "715204" } };
const ASK = { name: "get_policy", args: { question: "Can I pay my invoice with a cheque?" } };

function scripted(steps: { name?: string; args?: object; text?: string }[]): AgentModel {
  let i = 0;
  return {
    name: "scripted",
    async complete(_req, onText) {
      const s = steps[i++] ?? { text: "Done." };
      const turn: ModelTurn = {
        content: s.text ?? "",
        toolCalls: s.name ? [{ id: `call_${i}`, name: s.name, arguments: JSON.stringify(s.args) }] : [],
        usage: { model: "scripted", tokensIn: 1, tokensOut: 1, cachedTokens: 0 },
      };
      if (turn.content) onText(turn.content);
      return turn;
    },
  };
}

function setup(steps: Parameters<typeof scripted>[0]) {
  const events = new MemoryEventStore();
  const tickets = new MemoryTickets();
  const tools: ToolDeps = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets, policy: LOW, now: () => NOW };
  const emitted: AgentEvent[] = [];
  const turn = () => runTurn({ sessionId: "sess-esc", message: "question", channel: "chat" }, { model: scripted(steps), events, tools }, (e) => emitted.push(e));
  return { events, tickets, tools, emitted, turn };
}

describe("low-confidence escalation in chat", () => {
  it("verified customer: a P3 low_confidence ticket is opened in code and the turn ends escalated", async () => {
    const s = setup([VERIFY, ASK, { text: "I couldn't answer that reliably, so I've passed it to a person. " }]);
    const r = await s.turn();
    expect(r.state).toBe("escalated");
    const esc = s.emitted.find((e) => e.type === "escalation");
    // The card shows the guardrail's reason; the ticket itself is filed under low_confidence.
    expect(esc).toMatchObject({ kind: "ticket", reason: "low_retrieval_confidence", confidence: 0.214, ticket: { priority: "P3" } });
    expect(escalationReasonText((esc as { reason: string }).reason)).toBe("no relevant policy found");
    expect([...s.tickets.tickets.values()]).toHaveLength(1);
    const logged = (await s.events.list("sess-esc")).map((e) => e.event).find((e) => e.type === "escalation");
    expect(logged).toMatchObject({ kind: "ticket", confidence: 0.214, reason: "low_retrieval_confidence", ticket: { reason: "low_confidence" } });
    expect(r.trace.spans.find((x) => x.name === "turn_end")?.output).toMatchObject({ state: "escalated" });
  });

  it("unverified customer: escalation is offered (no ticket), still an escalated turn", async () => {
    const s = setup([ASK, { text: "I can't answer that reliably. I can pass it to a person once you verify. " }]);
    const r = await s.turn();
    expect(r.state).toBe("escalated");
    expect(s.emitted.find((e) => e.type === "escalation")).toMatchObject({ kind: "suggested", reason: "low_retrieval_confidence", confidence: 0.214 });
    expect(s.tickets.tickets.size).toBe(0);
  });

  it("the model is told what to say: the ticket number when one was opened", async () => {
    const s = setup([VERIFY, ASK, { text: "ok " }]);
    await s.turn();
    const toolResult = (await s.events.list("sess-esc")).map((e) => e.event).find((e) => e.type === "tool_result" && e.name === "get_policy");
    expect(JSON.stringify(toolResult)).toMatch(/ESC-\d+/);
    expect(JSON.stringify(toolResult)).toContain("next_step");
  });
});

describe("low-confidence escalation in voice", () => {
  it("voice get_policy opens the ticket, returns a handoff instruction, and records an escalated turn", async () => {
    const s = setup([]);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const turnId = "22222222-2222-4222-8222-222222222222";
    await runVoiceTool({ sessionId, turnId, callId: "v0", name: "verify_identity", arguments: JSON.stringify(VERIFY.args) }, { events: s.events, tools: s.tools });
    const traces: { name: string; output: unknown }[] = [];
    const r = await runVoiceTool(
      { sessionId, turnId, callId: "v1", name: "get_policy", arguments: JSON.stringify(ASK.args) },
      { events: s.events, tools: s.tools, traceSink: async (t) => void traces.push(...t.spans.map((x) => ({ name: x.name, output: x.output }))) },
    );
    expect(r.events.find((e) => e.type === "escalation")).toMatchObject({ kind: "ticket", confidence: 0.214 });
    expect(r.output).toMatch(/ESC-\d+/);
    expect(r.output).toMatch(/handed|person/i);
    expect(traces.find((t) => t.name === "turn_end")?.output).toMatchObject({ state: "escalated" });
  });
});

describe("escalation reason wording", () => {
  it("maps guardrail reasons to plain text and falls back to the code", () => {
    expect(escalationReasonText("unsupported_claim")).toBe("answer not supported by policy");
    expect(escalationReasonText("answer_declined")).toBe("our documentation doesn't cover this");
    expect(escalationReasonText("some_new_reason")).toBe("some new reason");
  });
});
