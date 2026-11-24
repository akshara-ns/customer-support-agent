/**
 * The four agent tools. Each takes validated input + context + deps and returns a typed
 * result. Policy checks happen here, in code; nothing the model says can skip them.
 */
import { createHash } from "node:crypto";
import {
  MAX_FAILED_VERIFICATIONS,
  evaluateRefund,
  refundDeadline,
  responseTarget,
  ticketPriority,
} from "@/lib/tools/policy";
import type { PolicyAnswer, ToolDeps } from "@/lib/tools/stores";
import type {
  RefundReceipt,
  Ticket,
  TicketReason,
  ToolContext,
  ToolError,
  ToolResult,
  VerifiedCustomer,
} from "@/lib/tools/types";
import type { ContractStatus, Tier } from "@/lib/types";

const hash = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
const fail = (error: ToolError): { ok: false; error: ToolError } => ({ ok: false, error });

// ---------- verify_identity ----------

export interface VerifyOutput {
  customer_id: string;
  tier: Tier;
  contract_status: ContractStatus;
  contract_end: string | null;
  invoices: {
    invoice_id: string;
    date: string;
    amount_usd: number;
    description: string;
    refunded_usd: number;
    refundable_until: string;
  }[];
}

export interface VerifyEffects {
  verified?: VerifiedCustomer;
  failedVerification?: boolean;
  ticket?: Ticket;
}

export async function verifyIdentity(
  input: { email: string; code: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<{ result: ToolResult<VerifyOutput>; effects: VerifyEffects }> {
  if (ctx.failedVerifications >= MAX_FAILED_VERIFICATIONS) {
    return {
      result: fail({ code: "IDENTITY_LOCKED", message: "Too many failed verification attempts in this conversation.", retryable: false }),
      effects: {},
    };
  }
  const user = deps.customers.findByEmail(input.email);
  if (!user || user.supportPin !== input.code.trim()) {
    const attempts = ctx.failedVerifications + 1;
    if (attempts >= MAX_FAILED_VERIFICATIONS) {
      // Policy: after three failed attempts, stop and escalate to the security team.
      const t = await openTicket(
        { reason: "security", summary: "Three failed identity verification attempts in one conversation." },
        { ...ctx, customer: null },
        deps,
      );
      return {
        result: fail({
          code: "IDENTITY_LOCKED",
          message: `Verification failed ${attempts} times, so account access is locked for this conversation. Security ticket ${t.ticketNumber} was created.`,
          retryable: false,
        }),
        effects: { failedVerification: true, ticket: t },
      };
    }
    // Same message whether the email exists or not: never confirm an account exists.
    return {
      result: fail({
        code: "VERIFICATION_FAILED",
        message: `The email and support PIN don't match our records (attempt ${attempts} of ${MAX_FAILED_VERIFICATIONS}).`,
        retryable: true,
      }),
      effects: { failedVerification: true },
    };
  }

  // Policy limits are not returned here: policy questions go through get_policy (grounded, cited).
  const invoices = await Promise.all(
    user.invoices.map(async (i) => ({
      invoice_id: i.invoiceId,
      date: i.date,
      amount_usd: i.amountUsd,
      description: i.description,
      refunded_usd: i.refundedUsd + (await deps.ledger.refundedUsd(user.customerId, i.invoiceId)),
      refundable_until: refundDeadline(i, user.tier),
    })),
  );
  // Data minimisation: no name, email or PIN goes back to the model.
  return {
    result: {
      ok: true,
      data: {
        customer_id: user.customerId,
        tier: user.tier,
        contract_status: user.contractStatus,
        contract_end: user.contractEnd,
        invoices,
      },
    },
    effects: { verified: { customerId: user.customerId, tier: user.tier, contractStatus: user.contractStatus } },
  };
}

// ---------- get_policy ----------

export async function getPolicy(
  input: { question: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<ToolResult<PolicyAnswer & { tier_scope: Tier | "general" }>> {
  const tier = ctx.customer?.tier ?? null;
  const answer = await deps.policy.search(input.question, tier, ctx.trace);
  return { ok: true, data: { ...answer, tier_scope: tier ?? "general" } };
}

// ---------- issue_refund ----------

export async function issueRefund(
  input: { invoice_id: string; amount_usd: number; reason: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<ToolResult<RefundReceipt>> {
  const customer = ctx.customer;
  if (!customer) return fail({ code: "NOT_VERIFIED", message: "Identity must be verified before a refund.", retryable: false });

  const record = deps.customers.get(customer.customerId);
  const invoice = record?.invoices.find((i) => i.invoiceId === input.invoice_id);
  const amountCents = Math.round(input.amount_usd * 100);
  const key = hash("refund", ctx.sessionId, input.invoice_id, amountCents);

  // Write-ahead: the request is recorded before anything is decided or acknowledged.
  const { created, entry } = await deps.ledger.begin({
    idempotencyKey: key,
    sessionId: ctx.sessionId,
    customerId: customer.customerId,
    invoiceId: input.invoice_id,
    amountUsd: input.amount_usd,
  });
  if (!created && entry.status === "succeeded") {
    return { ok: true, data: { ...(entry.result as RefundReceipt), replayed: true } };
  }
  if (!created && entry.status === "rejected") {
    return { ok: false, error: entry.result as ToolError };
  }

  const alreadyRefundedUsd = (invoice?.refundedUsd ?? 0) + (await deps.ledger.refundedUsd(customer.customerId, input.invoice_id));
  const violation = evaluateRefund({ customer, invoice, amountUsd: input.amount_usd, alreadyRefundedUsd, now: deps.now() });
  if (violation) {
    if (violation.escalationRequired && violation.suggestedEscalation) {
      // Policy requires a human here (billing error, suspension, chargeback): open the ticket in code.
      violation.ticket = await openTicket(
        {
          reason: violation.suggestedEscalation,
          summary: `Refund request for ${input.invoice_id} ($${input.amount_usd}) blocked: ${violation.message} Customer reason: ${input.reason}`,
        },
        ctx,
        deps,
      );
      violation.message += ` Ticket ${violation.ticket.ticketNumber} (${violation.ticket.priority}) was opened for the team that handles it.`;
    }
    await deps.ledger.complete(key, "rejected", violation);
    return fail(violation);
  }

  const receipt: RefundReceipt = {
    refundId: `rf_${key.slice(0, 12)}`,
    invoiceId: input.invoice_id,
    amountUsd: input.amount_usd,
    status: "issued",
    arrivesIn: "5-10 business days",
    replayed: false,
  };
  // Acknowledge only once the ledger says succeeded. If this write fails, the caller sees a failure.
  await deps.ledger.complete(key, "succeeded", receipt);
  return { ok: true, data: receipt };
}

// ---------- create_escalation_ticket ----------

async function openTicket(
  input: { reason: TicketReason; summary: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<Ticket> {
  const priority = ticketPriority(input.reason);
  const tier = ctx.customer?.tier ?? null;
  const { ticketNumber, replayed } = await deps.tickets.create({
    idempotencyKey: hash("ticket", ctx.sessionId, input.reason),
    sessionId: ctx.sessionId,
    customerId: ctx.customer?.customerId ?? null,
    tier,
    contractStatus: ctx.customer?.contractStatus ?? null,
    reason: input.reason,
    priority,
    summary: input.summary.slice(0, 1000),
  });
  return { ticketNumber, priority, reason: input.reason, responseTarget: responseTarget(tier, priority), status: "open", replayed };
}

export async function createEscalationTicket(
  input: { reason: TicketReason; summary: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<ToolResult<Ticket>> {
  return { ok: true, data: await openTicket(input, ctx, deps) };
}
