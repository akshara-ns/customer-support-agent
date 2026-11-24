/**
 * The refunded invoice must be the one the customer asked about (reported: the model refunded inv_2002
 * after the customer asked about inv_2001). If they didn't say and several are eligible, ask (chat).
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { requestedInvoices } from "@/lib/tools/policy";
import { recordVoiceEvent, runVoiceTool } from "@/lib/voice/bridge";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };
const call = (name: string, args: object): ModelTurn => ({ content: "", toolCalls: [{ id: `${name}${Math.random()}`, name, arguments: JSON.stringify(args) }], usage });
const done: ModelTurn = { content: "ok ", toolCalls: [], usage };
const VERIFY_OK = call("verify_identity", { email: "omar@example.com", code: "715204" });
const refund = (invoice_id: string, amount_usd: number) => call("issue_refund", { invoice_id, amount_usd, reason: "r" });

function session() {
  const events = new MemoryEventStore();
  const ledger = new MemoryLedger();
  const tools = { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation" as const, reason: "x", confidence: 0 }) }, now: () => NOW };
  const turn = (message: string, steps: ModelTurn[]) => {
    let i = 0;
    const model: AgentModel = { name: "s", complete: async () => steps[i++] ?? done };
    return runTurn({ sessionId: "s-im", message, channel: "chat" }, { model, events, tools }, () => {});
  };
  const refundResult = async () =>
    JSON.stringify((await events.list("s-im")).map((e) => e.event).filter((e) => e.type === "tool_result" && e.name === "issue_refund").at(-1));
  return { ledger, turn, refundResult };
}

describe("refund must match the invoice the customer asked about", () => {
  it("reported case: asked about inv_2001, model refunds inv_2002 → INVOICE_MISMATCH, nothing recorded", async () => {
    const s = session();
    await s.turn("My email is omar@example.com and my PIN is 111111. Refund inv_2001.", [call("verify_identity", { email: "omar@example.com", code: "111111" }), done]);
    await s.turn("omar@example.com / 715204", [VERIFY_OK, refund("inv_2002", 174), done]);
    expect(await s.refundResult()).toContain("INVOICE_MISMATCH");
    expect(s.ledger.entries.size).toBe(0);
  });

  it("the requested invoice goes through", async () => {
    const s = session();
    await s.turn("omar@example.com 715204, please refund inv_2002, it was a duplicate", [VERIFY_OK, refund("inv_2002", 174), done]);
    expect([...s.ledger.entries.values()].map((e) => e.status)).toEqual(["succeeded"]);
  });

  it("no invoice named and several eligible → INVOICE_AMBIGUOUS (the agent must ask)", async () => {
    const s = session();
    await s.turn("omar@example.com 715204, please refund my charge", [VERIFY_OK, refund("inv_2002", 174), done]);
    expect(await s.refundResult()).toContain("INVOICE_AMBIGUOUS");
    expect(s.ledger.entries.size).toBe(0);
  });

  it("a uniquely identifying amount picks the invoice ($29 → inv_2004, not inv_2005)", async () => {
    const s = session();
    await s.turn("omar@example.com 715204, refund the $29 seat charge", [VERIFY_OK, refund("inv_2005", 29), done]);
    expect(await s.refundResult()).toContain("INVOICE_MISMATCH");
  });
});

describe("requestedInvoices", () => {
  const invoices = customerDirectory(NOW).get("cus_pro_omar")!.invoices;
  it("ids, unique amounts and description words; union across messages", () => {
    expect(requestedInvoices(["refund inv_2001"], invoices)).toEqual(new Set(["inv_2001"]));
    expect(requestedInvoices(["the duplicate charge please"], invoices)).toEqual(new Set(["inv_2002"]));
    expect(requestedInvoices(["refund the $29 seat"], invoices)).toEqual(new Set(["inv_2004"]));
    expect(requestedInvoices(["refund the $29 seat", "now the storage add-on"], invoices)).toEqual(new Set(["inv_2004", "inv_2006"]));
    expect(requestedInvoices(["please refund my charge"], invoices)).toBeNull();
  });
});

describe("voice bridge", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const TURN = "22222222-2222-4222-8222-222222222222";
  async function voice(transcript?: string) {
    const events = new MemoryEventStore();
    const ledger = new MemoryLedger();
    const tools = { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation" as const, reason: "x", confidence: 0 }) }, now: () => NOW };
    await runVoiceTool({ sessionId: SESSION, turnId: TURN, callId: "v0", name: "verify_identity", arguments: JSON.stringify({ email: "omar@example.com", code: "715204" }) }, { events, tools });
    if (transcript) await recordVoiceEvent(SESSION, TURN, { kind: "user_transcript", text: transcript, at: 1 }, { events, traces: { write: async () => {} } });
    const r = await runVoiceTool({ sessionId: SESSION, turnId: TURN, callId: "v1", name: "issue_refund", arguments: JSON.stringify({ invoice_id: "inv_2005", amount_usd: 29, reason: "seat" }) }, { events, tools });
    return { r, ledger };
  }
  it("refuses an invoice that doesn't match what the caller already said", async () => {
    const { r } = await voice("please refund the $29 extra seat charge");
    expect(r.output).toContain("INVOICE_MISMATCH");
  });
  it("documented gap: with no caller transcript logged yet, there is nothing to check against", async () => {
    const { r } = await voice();
    expect(r.output).not.toContain("INVOICE_MISMATCH");
  });
});
