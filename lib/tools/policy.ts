/**
 * Support policy as code (mirrors data/policies). Pure functions: the model can ask for
 * anything, these decide. Unit-tested in tests/tools.test.ts.
 */
import type { Tier } from "@/lib/types";
import type { Invoice, TicketReason, ToolError, VerifiedCustomer } from "@/lib/tools/types";

export const REFUND_RULES: Record<Tier, { maxUsd: number; windowDays: number }> = {
  free: { maxUsd: 20, windowDays: 7 },
  pro: { maxUsd: 200, windowDays: 30 },
  enterprise: { maxUsd: 1000, windowDays: 60 },
};

export const MAX_FAILED_VERIFICATIONS = 3;

const DAY_MS = 86_400_000;

export function daysBetween(fromIsoDate: string, now: Date): number {
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - from) / DAY_MS);
}

export function refundDeadline(invoice: Invoice, tier: Tier): string {
  const d = new Date(Date.parse(`${invoice.date}T00:00:00Z`) + REFUND_RULES[tier].windowDays * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export interface RefundRequest {
  customer: VerifiedCustomer;
  invoice: Invoice | undefined;
  amountUsd: number;
  /** Already refunded on this invoice: CRM history plus succeeded ledger entries. */
  alreadyRefundedUsd: number;
  now: Date;
}

/** Returns the first policy rule the request breaks, or null if it may be issued. */
export function evaluateRefund(r: RefundRequest): ToolError | null {
  const { customer, invoice, amountUsd } = r;
  const rules = REFUND_RULES[customer.tier];

  if (customer.contractStatus === "expired") {
    return {
      code: "CONTRACT_NOT_ACTIVE",
      message:
        "The contract has expired, so refunds can't be issued here. A charge billed after the contract ended is handled by the billing team as a billing error.",
      retryable: false,
      suggestedEscalation: "billing_error",
      escalationRequired: true,
    };
  }
  if (customer.contractStatus === "suspended") {
    return {
      code: "CONTRACT_NOT_ACTIVE",
      message: "The account is suspended, so refunds and account changes aren't possible here; the billing team handles it.",
      retryable: false,
      suggestedEscalation: "account_suspended",
      escalationRequired: true,
    };
  }
  if (!invoice) {
    return { code: "INVOICE_NOT_FOUND", message: "That invoice isn't on this account.", retryable: false };
  }
  if (invoice.chargeback) {
    return {
      code: "CHARGEBACK_FILED",
      message: "A chargeback has already been filed for this charge, so it can't also be refunded.",
      retryable: false,
      suggestedEscalation: "billing_error",
      escalationRequired: true,
    };
  }
  if (r.alreadyRefundedUsd > 0) {
    return {
      code: "ALREADY_REFUNDED",
      message: `Invoice ${invoice.invoiceId} has already been refunded ($${r.alreadyRefundedUsd}); only one refund is allowed per invoice.`,
      retryable: false,
    };
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || Math.round(amountUsd * 100) !== amountUsd * 100) {
    return { code: "INVALID_AMOUNT", message: "The refund amount must be a positive amount in dollars and cents.", retryable: false };
  }
  if (amountUsd > invoice.amountUsd) {
    return {
      code: "AMOUNT_EXCEEDS_INVOICE",
      message: `The refund can't exceed the invoice amount ($${invoice.amountUsd}).`,
      retryable: false,
    };
  }
  const age = daysBetween(invoice.date, r.now);
  if (age > rules.windowDays) {
    return {
      code: "OUTSIDE_REFUND_WINDOW",
      message: `Invoice ${invoice.invoiceId} is ${age} days old; ${customer.tier} refunds must be requested within ${rules.windowDays} days.`,
      retryable: false,
      suggestedEscalation: "refund_outside_window",
    };
  }
  if (amountUsd > rules.maxUsd) {
    return {
      code: "OVER_TIER_LIMIT",
      message: `$${amountUsd} is above the $${rules.maxUsd} per-request limit for the ${customer.tier} tier; larger refunds go to the billing team.`,
      retryable: false,
      suggestedEscalation: "refund_over_limit",
    };
  }
  return null;
}

/** Escalation policy: priority from the reason. */
export function ticketPriority(reason: TicketReason): "P1" | "P2" | "P3" {
  if (reason === "security") return "P1";
  if (["refund_over_limit", "refund_outside_window", "billing_error", "account_suspended", "privacy_request"].includes(reason)) {
    return "P2";
  }
  return "P3";
}

/** First-response target for the customer's tier (escalation policy + plans doc). */
export function responseTarget(tier: Tier | null, priority: "P1" | "P2" | "P3"): string {
  if (tier === "enterprise") {
    return { P1: "1 hour", P2: "4 business hours", P3: "1 business day" }[priority];
  }
  if (tier === "pro") return "1 business day";
  return "3 business days";
}
