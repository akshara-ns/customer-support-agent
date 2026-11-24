/**
 * Reproductions for review findings (docs/REVIEW.md). Each test failed before its fix.
 */
import { describe, expect, it } from "vitest";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { evaluateRefund } from "@/lib/tools/policy";
import { executeTool } from "@/lib/tools/registry";
import type { PolicySearch, ToolDeps } from "@/lib/tools/stores";
import type { ToolContext, VerifiedCustomer } from "@/lib/tools/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const policy: PolicySearch = { search: async () => ({ status: "needs_escalation", reason: "x", confidence: 0 }) };
const OMAR: VerifiedCustomer = { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" };
const ctx = (sessionId: string): ToolContext => ({ sessionId, turnId: "t", customer: OMAR, failedVerifications: 0 });

describe("R1: valid cent amounts are accepted", () => {
  it("accepts $19.99, $1.15, $0.29 and $4.35 (float rounding must not reject them)", () => {
    const invoice = { invoiceId: "i", date: "2026-11-20", amountUsd: 100, description: "", refundedUsd: 0, chargeback: false };
    for (const amountUsd of [19.99, 1.15, 0.29, 4.35, 58]) {
      expect(evaluateRefund({ customer: OMAR, invoice, amountUsd, alreadyRefundedUsd: 0, now: NOW }), String(amountUsd)).toBeNull();
    }
    expect(evaluateRefund({ customer: OMAR, invoice, amountUsd: 10.555, alreadyRefundedUsd: 0, now: NOW })?.code).toBe("INVALID_AMOUNT");
  });
});

describe("R2: one refund per invoice holds under concurrency", () => {
  it("two concurrent refunds on the same invoice with different amounts/sessions: at most one succeeds", async () => {
    const ledger = new MemoryLedger();
    const deps: ToolDeps = { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy, now: () => NOW };
    const run = (session: string, amount: number) =>
      executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2001", amount_usd: amount, reason: "x" }), ctx(session), deps);
    const [a, b] = await Promise.all([run("s-a", 100), run("s-b", 74)]);
    const succeeded = [a, b].filter((r) => r.result.ok);
    expect(succeeded).toHaveLength(1);
    const loser = [a, b].find((r) => !r.result.ok);
    expect(loser && !loser.result.ok && loser.result.error.code).toMatch(/ALREADY_REFUNDED|REFUND_IN_PROGRESS/);
  });
});

describe("G2: placeholder credentials don't burn a verification attempt", () => {
  it("rejects a malformed email or non-6-digit PIN as INVALID_INPUT, not a failed attempt", async () => {
    const deps: ToolDeps = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy, now: () => NOW };
    const c: ToolContext = { sessionId: "s", turnId: "t", customer: null, failedVerifications: 0 };
    for (const args of [{ email: "unknown", code: "[pin]" }, { email: "omar@example.com", code: "abc" }, { email: "omar@example.com", code: "12345" }]) {
      const r = await executeTool("verify_identity", JSON.stringify(args), c, deps);
      expect(r.result.ok).toBe(false);
      expect(!r.result.ok && r.result.error.code, JSON.stringify(args)).toBe("INVALID_INPUT");
      expect(r.effects.failedVerification).toBeUndefined();
    }
  });
});

describe("G5: lockout is per account, not just per session", () => {
  it("after 5 failed attempts on one email across sessions, a NEW session is locked too", async () => {
    const { MemoryVerifyGuard } = await import("@/lib/tools/memory-stores");
    const guard = new MemoryVerifyGuard();
    const deps: ToolDeps = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy, now: () => NOW, verifyGuard: guard };
    for (let i = 0; i < 5; i++) {
      const c: ToolContext = { sessionId: `s${i}`, turnId: "t", customer: null, failedVerifications: 0 };
      await executeTool("verify_identity", JSON.stringify({ email: "omar@example.com", code: "000000" }), c, deps);
    }
    const fresh: ToolContext = { sessionId: "s-new", turnId: "t", customer: null, failedVerifications: 0 };
    const r = await executeTool("verify_identity", JSON.stringify({ email: "omar@example.com", code: "715204" }), fresh, deps);
    expect(!r.result.ok && r.result.error.code).toBe("IDENTITY_LOCKED");
    expect(r.effects.verified).toBeUndefined();
  });
});

describe("G3: claim gate knows the session, and catches paraphrases", () => {
  it("does not rewrite a true reference to an earlier refund; still corrects false ones and paraphrases", async () => {
    const { checkSentence } = await import("@/lib/agent/claims");
    const earlier = {
      refunds: [{ refundId: "r", invoiceId: "inv_2005", amountUsd: 58, status: "issued" as const, arrivesIn: "5-10 business days", replayed: false }],
      refundErrors: [],
      tickets: [{ ticketNumber: "ESC-1042", priority: "P2" as const, reason: "refund_over_limit" as const, responseTarget: "1 business day", status: "open" as const, replayed: false }],
    };
    expect(checkSentence("Yes, your refund of $58 on inv_2005 was issued in our earlier exchange.", earlier).corrected).toBe(false);
    expect(checkSentence("Your ticket is ESC-1042.", earlier).corrected).toBe(false);
    const none = { refunds: [], refundErrors: [], tickets: [] };
    expect(checkSentence("I've credited $500 back to your account.", none).corrected).toBe(true);
    expect(checkSentence("The money is on its way back to your card.", none).corrected).toBe(true);
    expect(checkSentence("Refunds go back to the original payment method.", none).corrected).toBe(false);
  });

  it("runTurn seeds the claim gate with refunds and tickets from earlier turns in the session", async () => {
    const { runTurn } = await import("@/lib/agent/run");
    const { MemoryEventStore } = await import("@/lib/session/events");
    const events = new MemoryEventStore();
    const ledger = new MemoryLedger();
    const deps = {
      events,
      tools: { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy, now: () => NOW },
      model: {
        name: "scripted",
        calls: 0,
        async complete(_r: unknown, onText: (d: string) => void) {
          const steps = [
            { content: "", toolCalls: [{ id: "c1", name: "verify_identity", arguments: JSON.stringify({ email: "omar@example.com", code: "715204" }) }] },
            { content: "", toolCalls: [{ id: "c2", name: "issue_refund", arguments: JSON.stringify({ invoice_id: "inv_2005", amount_usd: 58, reason: "x" }) }] },
            { content: "Done. ", toolCalls: [] },
            { content: "Yes, your refund of $58 on inv_2005 was issued earlier. ", toolCalls: [] },
          ];
          const s = steps[this.calls++];
          onText(s.content);
          return { ...s, usage: { model: "scripted", tokensIn: 1, tokensOut: 1, cachedTokens: 0 } };
        },
      },
    };
    await runTurn({ sessionId: "g3", message: "omar@example.com 715204 refund inv_2005 $58", channel: "chat" }, deps, () => {});
    const second = await runTurn({ sessionId: "g3", message: "did that go through?", channel: "chat" }, deps, () => {});
    expect(second.corrections).toEqual([]);
    expect(second.reply).toContain("$58");
  });
});

describe("G4: PINs are not stored in the session log", () => {
  it("logs the user message with the PIN redacted, but the model still sees it for this turn", async () => {
    const { runTurn } = await import("@/lib/agent/run");
    const { MemoryEventStore } = await import("@/lib/session/events");
    const events = new MemoryEventStore();
    const seen: string[] = [];
    const deps = {
      events,
      tools: { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy, now: () => NOW },
      model: {
        name: "scripted",
        async complete(req: { messages: { role: string; content?: unknown }[] }, onText: (d: string) => void) {
          seen.push(JSON.stringify(req.messages));
          onText("Thanks.");
          return { content: "Thanks.", toolCalls: [], usage: { model: "scripted", tokensIn: 1, tokensOut: 1, cachedTokens: 0 } };
        },
      },
    };
    await runTurn({ sessionId: "g4", message: "I'm omar@example.com, PIN 715204", channel: "chat" }, deps, () => {});
    const logged = JSON.stringify(await events.list("g4"));
    expect(logged).not.toContain("715204");
    expect(seen[0]).toContain("715204");
  });
});
