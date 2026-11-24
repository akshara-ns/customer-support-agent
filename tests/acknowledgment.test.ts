/** A tool turn with no model preamble streams a short acknowledgment before the first tool runs (Phase 9). */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { ACKNOWLEDGMENT, runTurn } from "@/lib/agent/run";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { AgentEvent } from "@/lib/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };

async function run(first: ModelTurn) {
  const steps: ModelTurn[] = [first, { content: "Thanks for waiting. ", toolCalls: [], usage }];
  let i = 0;
  const model: AgentModel = { name: "s", complete: async (_r, onText) => { const t = steps[i++]; if (t.content) onText(t.content); return t; } };
  const tools = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: { search: async () => ({ status: "answered" as const, answer: "x [a#1]", citations: ["a#1"], confidence: 0.6 }) }, now: () => NOW };
  const emitted: AgentEvent[] = [];
  await runTurn({ sessionId: "s-ack", message: "q", channel: "chat" }, { model, events: new MemoryEventStore(), tools }, (e) => emitted.push(e));
  return emitted;
}
const call = { id: "c1", name: "get_policy", arguments: JSON.stringify({ question: "q" }) };

describe("early acknowledgment", () => {
  it("is the first text, before the first tool step starts, when the model gave no preamble", async () => {
    const e = await run({ content: "", toolCalls: [call], usage });
    const firstToken = e.findIndex((x) => x.type === "token");
    const firstStep = e.findIndex((x) => x.type === "step_started");
    expect(e[firstToken]).toMatchObject({ type: "token", text: ACKNOWLEDGMENT });
    expect(firstToken).toBeLessThan(firstStep);
  });

  it("is not added when the model already said something", async () => {
    const e = await run({ content: "Let me look that up. ", toolCalls: [call], usage });
    expect(e.filter((x) => x.type === "token").map((x) => (x as { text: string }).text).join("")).not.toContain(ACKNOWLEDGMENT.trim());
  });

  it("separates a preamble and the answer from different model steps with a space", async () => {
    const e = await run({ content: "Let me look that up.", toolCalls: [call], usage });
    const text = e.filter((x) => x.type === "token").map((x) => (x as { text: string }).text).join("");
    expect(text).toContain("Let me look that up. Thanks for waiting.");
  });
});
