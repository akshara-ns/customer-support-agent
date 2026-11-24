/**
 * Layer 2 of the action-claim check, with a fake extractor (no API cost): held sentences are checked
 * once at the end of the reply, false claims are replaced with the truth before release, and a
 * checker failure falls back to the regex-checked text. Also the code-side comparison of extracted
 * claims with the tool log.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentModel } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { falseClaims } from "@/lib/guardrails/action-claims";
import { ClaimGate, type ActionChecker, type TurnActions } from "@/lib/guardrails/claims";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { AgentEvent } from "@/lib/types";

const NONE: TurnActions = { refunds: [], refundErrors: [], tickets: [] };
const REFUNDED: TurnActions = {
  refunds: [{ refundId: "rf", invoiceId: "inv_2004", amountUsd: 29, status: "issued", arrivesIn: "5-10 business days", replayed: false }],
  refundErrors: [],
  tickets: [],
};

/** Flags any sentence containing "complete" or "on its way" as a refund claim (stands in for the model). */
const fakeChecker: ActionChecker = async (reply) => ({
  falseClaims: (reply.match(/[^.!?]*(complete|on its way)[^.!?]*[.!?]/gi) ?? []).map((q) => ({ quote: q.trim(), claimed_action: "refund not issued" })),
});

function stream(gate: ClaimGate, text: string): string[] {
  const out: string[] = [];
  for (const piece of text.match(/[\s\S]{1,5}/g) ?? []) out.push(...gate.push(piece));
  return out;
}

describe("action-claim layer 2 in the gate", () => {
  it("releases text before the first money/ticket sentence at once, holds the rest, and replaces the false claim", async () => {
    const gate = new ClaimGate(() => NONE, true);
    const early = stream(gate, "Thanks for waiting. Your refund is complete. Anything else? ");
    expect(early.join("")).toBe("Thanks for waiting. "); // the regex misses the paraphrase; it is held, not shown
    const rest = await gate.settle(fakeChecker);
    const text = rest.join("");
    expect(text).not.toContain("complete");
    expect(text).toContain("No refund has been issued yet.");
    expect(text).toContain("Anything else?");
    expect(gate.corrections).toEqual([expect.objectContaining({ reason: "model: refund not issued" })]);
  });

  it("leaves a true reply unchanged", async () => {
    const gate = new ClaimGate(() => REFUNDED, true);
    stream(gate, "The $29 refund on inv_2004 has been issued. ");
    const checker = vi.fn(async () => ({ falseClaims: [] }));
    expect((await gate.settle(checker)).join("")).toBe("The $29 refund on inv_2004 has been issued. ");
    expect(checker).toHaveBeenCalledOnce();
    expect(gate.corrections).toEqual([]);
  });

  it("doesn't call the model when the reply never mentions money or tickets", async () => {
    const gate = new ClaimGate(() => NONE, true);
    const out = stream(gate, "Selective sync is in Preferences. ");
    const checker = vi.fn(fakeChecker);
    expect([...out, ...(await gate.settle(checker))].join("")).toBe("Selective sync is in Preferences. ");
    expect(checker).not.toHaveBeenCalled();
  });

  it("if the checker fails, releases the regex-checked text and reports the error", async () => {
    const gate = new ClaimGate(() => NONE, true);
    stream(gate, "Your $29 refund request was noted. ");
    const onError = vi.fn();
    const out = await gate.settle(async () => Promise.reject(new Error("timeout")), onError);
    expect(out.join("")).toBe("Your $29 refund request was noted. ");
    expect(onError).toHaveBeenCalled();
  });
});

describe("extracted claims vs the tool log (code)", () => {
  const refund = (amount_usd: number | null, invoice_id: string | null) => ({ quote: "q", action: "refund" as const, amount_usd, invoice_id, ticket_number: null });
  it("accepts claims that match an issued refund and rejects wrong amounts, invoices and tickets", () => {
    expect(falseClaims([refund(29, "inv_2004"), refund(null, null)], REFUNDED)).toEqual([]);
    expect(falseClaims([refund(174, null)], REFUNDED)).toHaveLength(1);
    expect(falseClaims([refund(29, "inv_2005")], REFUNDED)).toHaveLength(1);
    expect(falseClaims([refund(null, null)], NONE)).toHaveLength(1);
    expect(falseClaims([{ quote: "q", action: "ticket", amount_usd: null, invoice_id: null, ticket_number: "ESC-9" }], NONE)).toHaveLength(1);
  });
});

describe("runTurn with the layer-2 checker", () => {
  it("a paraphrased false refund claim never reaches the customer", async () => {
    const model: AgentModel = {
      name: "scripted",
      async complete(_req, onText) {
        const content = "Thanks, Omar. Great news, your $29 refund is on its way. Anything else? ";
        for (const piece of content.match(/[\s\S]{1,6}/g) ?? []) onText(piece);
        return { content, toolCalls: [], usage: { model: "scripted", tokensIn: 1, tokensOut: 1, cachedTokens: 0 } };
      },
    };
    const deps = {
      model,
      events: new MemoryEventStore(),
      tools: {
        customers: customerDirectory(new Date("2026-11-23T12:00:00Z")),
        ledger: new MemoryLedger(),
        tickets: new MemoryTickets(),
        policy: { search: async () => ({ status: "needs_escalation" as const, reason: "low_retrieval_confidence", confidence: 0.1 }) },
        now: () => new Date("2026-11-23T12:00:00Z"),
      },
      actionChecker: fakeChecker,
    };
    const emitted: AgentEvent[] = [];
    const r = await runTurn({ sessionId: "s-l2", message: "refund please", channel: "chat" }, deps, (e) => emitted.push(e));
    const shown = emitted.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");
    expect(shown).not.toContain("on its way");
    expect(shown).toContain("No refund has been issued yet.");
    expect(r.corrections.map((c) => c.reason)).toContain("model: refund not issued");
    expect(r.trace.spans.map((s) => s.name)).toContain("action_claim_check");
  });
});
