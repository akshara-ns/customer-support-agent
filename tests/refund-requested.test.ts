/**
 * A refund is only issued when the customer asked for one (review round 4: a live scenario run showed the
 * model refunding inv_2002 after the customer only sent their credentials). Enforced in tool code.
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { REFUND_INTENT } from "@/lib/tools/policy";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };
const tool = (name: string, args: object): ModelTurn => ({ content: "", toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }], usage });

async function turn(message: string) {
  const steps = [
    tool("verify_identity", { email: "omar@example.com", code: "715204" }),
    tool("issue_refund", { invoice_id: "inv_2002", amount_usd: 174, reason: "duplicate" }),
    { content: "Done. ", toolCalls: [], usage },
  ];
  let i = 0;
  const model: AgentModel = { name: "s", complete: async () => steps[i++] };
  const ledger = new MemoryLedger();
  const events = new MemoryEventStore();
  const tools = { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation" as const, reason: "x", confidence: 0 }) }, now: () => NOW };
  await runTurn({ sessionId: "s-rr", message, channel: "chat" }, { model, events, tools }, () => {});
  const result = (await events.list("s-rr")).map((e) => e.event).find((e) => e.type === "tool_result" && e.name === "issue_refund");
  return { ledger, result };
}

describe("refund only when the customer asked", () => {
  it("credentials only: issue_refund is refused with REFUND_NOT_REQUESTED and nothing is recorded", async () => {
    const { ledger, result } = await turn("omar@example.com / 715204");
    expect(JSON.stringify(result)).toContain("REFUND_NOT_REQUESTED");
    expect(ledger.entries.size).toBe(0);
  });

  it("an explicit request goes through", async () => {
    const { ledger } = await turn("omar@example.com / 715204, please refund the duplicate charge on inv_2002");
    expect([...ledger.entries.values()].map((e) => e.status)).toEqual(["succeeded"]);
  });

  it("recognises common ways to ask, and not unrelated text", () => {
    for (const t of ["Refund inv_2001", "I want my money back", "can you reimburse me", "credit it back please", "refunds?"]) expect(REFUND_INTENT.test(t)).toBe(true);
    for (const t of ["omar@example.com / 715204", "what's the sync limit?", "cancel my plan"]) expect(REFUND_INTENT.test(t)).toBe(false);
  });
});
