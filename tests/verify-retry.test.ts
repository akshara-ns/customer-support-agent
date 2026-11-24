/**
 * After a failed PIN, the agent only needs the new PIN: verify_identity reuses the email from this
 * conversation's last attempt (stored user messages are redacted, so the model can't repeat the email).
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { deriveState, MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { executeTool } from "@/lib/tools/registry";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };
const verify = (email: string | null, code: string): ModelTurn => ({ content: "", toolCalls: [{ id: `v${code}`, name: "verify_identity", arguments: JSON.stringify({ email, code }) }], usage });
const done: ModelTurn = { content: "ok ", toolCalls: [], usage };

function session() {
  const events = new MemoryEventStore();
  const tools = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation" as const, reason: "x", confidence: 0 }) }, now: () => NOW };
  const turn = (message: string, steps: ModelTurn[]) => {
    let i = 0;
    const model: AgentModel = { name: "s", complete: async () => steps[i++] ?? done };
    return runTurn({ sessionId: "s-vr", message, channel: "chat" }, { model, events, tools }, () => {});
  };
  return { events, tools, turn };
}
const results = async (events: MemoryEventStore) =>
  (await events.list("s-vr")).map((e) => e.event).filter((e) => e.type === "tool_result" && e.name === "verify_identity");

describe("verification retry reuses the email", () => {
  it("failed attempt → the result says to ask only for the PIN; a PIN-only retry verifies", async () => {
    const s = session();
    await s.turn("omar@example.com, PIN 111111", [verify("omar@example.com", "111111"), done]);
    expect(JSON.stringify((await results(s.events))[0])).toContain("ask only for the PIN");
    await s.turn("sorry, 715204", [verify(null, "715204"), done]);
    expect(deriveState(await s.events.list("s-vr")).customer?.customerId).toBe("cus_pro_omar");
  });

  it("PIN-only retries still count toward the 3-attempt lock", async () => {
    const s = session();
    await s.turn("omar@example.com 111111", [verify("omar@example.com", "111111"), done]);
    await s.turn("222222", [verify(null, "222222"), done]);
    await s.turn("333333", [verify(null, "333333"), done]);
    const last = (await results(s.events)).at(-1);
    expect(JSON.stringify(last)).toContain("IDENTITY_LOCKED");
  });

  it("no earlier attempt: a PIN-only call is refused as invalid input", async () => {
    const s = session();
    const r = await executeTool("verify_identity", JSON.stringify({ email: null, code: "715204" }), { sessionId: "x", turnId: "t", customer: null, failedVerifications: 0 }, s.tools);
    expect(r.result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });
});
