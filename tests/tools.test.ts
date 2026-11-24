import { beforeEach, describe, expect, it } from "vitest";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { evaluateRefund, REFUND_RULES } from "@/lib/tools/policy";
import { executeTool } from "@/lib/tools/registry";
import type { ActionLedger, PolicySearch, ToolDeps } from "@/lib/tools/stores";
import type { RefundReceipt, Ticket, ToolContext, ToolError, VerifiedCustomer } from "@/lib/tools/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const policy: PolicySearch = { search: async () => ({ status: "needs_escalation", reason: "low_retrieval_confidence", confidence: 0.1 }) };

let ledger: MemoryLedger;
let tickets: MemoryTickets;
let deps: ToolDeps;

beforeEach(() => {
  ledger = new MemoryLedger();
  tickets = new MemoryTickets();
  deps = { customers: customerDirectory(NOW), ledger, tickets, policy, now: () => NOW };
});

const ctx = (customer: VerifiedCustomer | null, extra: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: "s1",
  turnId: "t1",
  customer,
  failedVerifications: 0,
  ...extra,
});
const OMAR: VerifiedCustomer = { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" };
const refund = (c: ToolContext, invoice_id: string, amount_usd: number) =>
  executeTool("issue_refund", JSON.stringify({ invoice_id, amount_usd, reason: "test" }), c, deps);
const err = (r: { result: { ok: boolean } }) => (r.result as { ok: false; error: ToolError }).error;

describe("verify_identity", () => {
  it("returns only tier, contract and invoices (no name, email or PIN)", async () => {
    const r = await executeTool("verify_identity", JSON.stringify({ email: "Omar@Example.com", code: "715204" }), ctx(null), deps);
    expect(r.result.ok).toBe(true);
    const text = JSON.stringify(r.result);
    expect(text).toContain('"tier":"pro"');
    expect(text).not.toMatch(/Omar Haddad|omar@example.com|715204/);
    expect(r.effects.verified).toEqual(OMAR);
  });

  it("gives the same error for an unknown email and a wrong PIN", async () => {
    const a = await executeTool("verify_identity", JSON.stringify({ email: "nobody@example.com", code: "715204" }), ctx(null), deps);
    const b = await executeTool("verify_identity", JSON.stringify({ email: "omar@example.com", code: "000000" }), ctx(null), deps);
    expect(err(a).code).toBe("VERIFICATION_FAILED");
    expect(err(a).message).toBe(err(b).message);
    expect(a.effects.failedVerification).toBe(true);
  });

  it("locks after the third failure and opens a P1 security ticket", async () => {
    const r = await executeTool("verify_identity", JSON.stringify({ email: "omar@example.com", code: "000000" }), ctx(null, { failedVerifications: 2 }), deps);
    expect(err(r).code).toBe("IDENTITY_LOCKED");
    expect(r.effects.ticket?.priority).toBe("P1");
    const again = await executeTool("verify_identity", JSON.stringify({ email: "omar@example.com", code: "715204" }), ctx(null, { failedVerifications: 3 }), deps);
    expect(err(again).code).toBe("IDENTITY_LOCKED");
    expect(again.effects.verified).toBeUndefined();
  });
});

describe("issue_refund policy", () => {
  it("requires verified identity", async () => {
    expect(err(await refund(ctx(null), "inv_2001", 10)).code).toBe("NOT_VERIFIED");
  });

  it("issues a refund within the Pro limit and window", async () => {
    const r = await refund(ctx(OMAR), "inv_2002", 174);
    expect(r.result.ok).toBe(true);
    expect((r.result as { data: RefundReceipt }).data).toMatchObject({ invoiceId: "inv_2002", amountUsd: 174, status: "issued" });
  });

  it("refuses above the tier limit with an offered (not forced) escalation", async () => {
    const e = err(await refund(ctx(OMAR), "inv_2003", 900));
    expect(e.code).toBe("OVER_TIER_LIMIT");
    expect(e.suggestedEscalation).toBe("refund_over_limit");
    expect(e.escalationRequired).toBeFalsy();
    expect(tickets.tickets.size).toBe(0);
  });

  it("refuses more than the invoice amount", async () => {
    expect(err(await refund(ctx(OMAR), "inv_2001", 900)).code).toBe("AMOUNT_EXCEEDS_INVOICE");
  });

  it("refuses outside the refund window", async () => {
    expect(err(await refund(ctx(OMAR), "inv_2000", 100)).code).toBe("OUTSIDE_REFUND_WINDOW");
  });

  it("blocks expired contracts and opens the required billing ticket in code", async () => {
    const leo: VerifiedCustomer = { customerId: "cus_pro_expired_leo", tier: "pro", contractStatus: "expired" };
    const r = await refund(ctx(leo), "inv_4001", 87);
    expect(err(r).code).toBe("CONTRACT_NOT_ACTIVE");
    expect(r.effects.ticket).toMatchObject({ reason: "billing_error", priority: "P2" });
  });

  it("blocks suspended accounts", async () => {
    const ana: VerifiedCustomer = { customerId: "cus_pro_suspended_ana", tier: "pro", contractStatus: "suspended" };
    const r = await refund(ctx(ana), "inv_5001", 50);
    expect(err(r).code).toBe("CONTRACT_NOT_ACTIVE");
    expect(r.effects.ticket?.reason).toBe("account_suspended");
  });

  it("refuses an invoice already refunded in the CRM", async () => {
    const sam: VerifiedCustomer = { customerId: "cus_pro_refunded_sam", tier: "pro", contractStatus: "active" };
    expect(err(await refund(ctx(sam), "inv_6001", 145)).code).toBe("ALREADY_REFUNDED");
  });

  it("refuses a second refund on the same invoice, even from another session", async () => {
    expect((await refund(ctx(OMAR), "inv_2002", 100)).result.ok).toBe(true);
    const other = await refund(ctx(OMAR, { sessionId: "s2" }), "inv_2002", 50);
    expect(err(other).code).toBe("ALREADY_REFUNDED");
  });

  it("is idempotent: the same request in the same session returns the same receipt", async () => {
    const a = await refund(ctx(OMAR), "inv_2002", 174);
    const b = await refund(ctx(OMAR), "inv_2002", 174);
    const ra = (a.result as { data: RefundReceipt }).data;
    const rb = (b.result as { data: RefundReceipt }).data;
    expect(rb.refundId).toBe(ra.refundId);
    expect(rb.replayed).toBe(true);
    expect([...ledger.entries.values()].filter((e) => e.status === "succeeded")).toHaveLength(1);
  });

  it("writes the ledger before acknowledging success", async () => {
    const r = await refund(ctx(OMAR), "inv_2002", 174);
    expect(r.result.ok).toBe(true);
    expect(ledger.log[0]).toMatch(/^begin:/);
    expect(ledger.log[1]).toMatch(/^complete:succeeded:/);
  });

  it("never reports success if the ledger write fails", async () => {
    const broken: ActionLedger = {
      begin: ledger.begin.bind(ledger),
      refundedUsd: ledger.refundedUsd.bind(ledger),
      complete: async () => {
        throw new Error("db down");
      },
    };
    const r = await executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2002", amount_usd: 174, reason: "x" }), ctx(OMAR), {
      ...deps,
      ledger: broken,
    });
    expect(r.result.ok).toBe(false);
    expect(err(r).code).toBe("TOOL_FAILURE");
  });

  it("rejects invalid input with a typed error", async () => {
    const r = await executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2002" }), ctx(OMAR), deps);
    expect(err(r).code).toBe("INVALID_INPUT");
    expect(err(await refund(ctx(OMAR), "inv_2002", 10.555)).code).toBe("INVALID_AMOUNT");
  });

  it("matches the documented limits", () => {
    expect(REFUND_RULES).toEqual({
      free: { maxUsd: 20, windowDays: 7 },
      pro: { maxUsd: 200, windowDays: 30 },
      enterprise: { maxUsd: 1000, windowDays: 60 },
    });
    const ent: VerifiedCustomer = { customerId: "x", tier: "enterprise", contractStatus: "active" };
    const invoice = { invoiceId: "i", date: "2026-10-15", amountUsd: 5000, description: "", refundedUsd: 0, chargeback: false };
    expect(evaluateRefund({ customer: ent, invoice, amountUsd: 1000, alreadyRefundedUsd: 0, now: NOW })).toBeNull();
    expect(evaluateRefund({ customer: ent, invoice, amountUsd: 1000.01, alreadyRefundedUsd: 0, now: NOW })?.code).toBe("OVER_TIER_LIMIT");
    expect(evaluateRefund({ customer: ent, invoice: { ...invoice, chargeback: true }, amountUsd: 10, alreadyRefundedUsd: 0, now: NOW })?.code).toBe(
      "CHARGEBACK_FILED",
    );
  });
});

describe("create_escalation_ticket", () => {
  it("is idempotent per session and reason, with priority from policy", async () => {
    const args = JSON.stringify({ reason: "refund_over_limit", summary: "Customer wants $900 back on inv_2003." });
    const a = await executeTool("create_escalation_ticket", args, ctx(OMAR), deps);
    const b = await executeTool("create_escalation_ticket", args, ctx(OMAR), deps);
    const ta = (a.result as { data: Ticket }).data;
    const tb = (b.result as { data: Ticket }).data;
    expect(ta.priority).toBe("P2");
    expect(ta.responseTarget).toBe("1 business day");
    expect(tb.ticketNumber).toBe(ta.ticketNumber);
    expect(tb.replayed).toBe(true);
  });
});
