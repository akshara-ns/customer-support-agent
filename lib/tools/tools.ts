/**
 * The four agent tools. Each takes validated input + context + deps and returns a typed
 * result. Policy checks happen here, in code; nothing the model says can skip them.
 */
import { createHash } from "node:crypto";
import { activeFault } from "@/lib/faults";
import {
  MAX_ACCOUNT_FAILURES,
  MAX_FAILED_VERIFICATIONS,
  PENDING_REFUND_EXPIRY_SEC,
  evaluateRefund,
  refundDeadline,
  responseTarget,
  ticketPriority,
} from "@/lib/tools/policy";
import type { PolicyOutput, ToolEffects, VerifyOutput } from "@/lib/contracts";
import type { ToolDeps } from "@/lib/tools/stores";
import type { CustomerRecord, RefundReceipt, Ticket, TicketReason, ToolContext, ToolError, ToolResult } from "@/lib/tools/types";

const hash = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 40);
const fail = (error: ToolError): { ok: false; error: ToolError } => ({ ok: false, error });

/** Ledger results are stored JSON: check the shape before trusting it (no blind casts). */
function asReceipt(v: unknown): RefundReceipt {
  const r = v as Partial<RefundReceipt> | null;
  if (!r || typeof r.refundId !== "string" || typeof r.amountUsd !== "number" || typeof r.invoiceId !== "string") {
    throw new Error("ledger entry has no valid refund receipt");
  }
  return { refundId: r.refundId, invoiceId: r.invoiceId, amountUsd: r.amountUsd, status: "issued", arrivesIn: r.arrivesIn ?? "5-10 business days", replayed: true };
}
function asToolError(v: unknown): ToolError {
  const e = v as Partial<ToolError> | null;
  if (!e || typeof e.code !== "string" || typeof e.message !== "string") throw new Error("ledger entry has no valid error");
  return e as ToolError;
}

// ---------- verify_identity ----------

/** @deprecated use ToolEffects from lib/contracts */
export type VerifyEffects = ToolEffects;

export async function verifyIdentity(
  args: { email: string | null; code: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<{ result: ToolResult<VerifyOutput>; effects: ToolEffects }> {
  // A retry may send only the new PIN: the email from this conversation's last attempt is reused.
  const email = args.email ?? ctx.lastVerifyEmail ?? null;
  if (!email) {
    return { result: fail({ code: "INVALID_INPUT", message: "Ask the customer for the email on the account and their support PIN.", retryable: false }), effects: {} };
  }
  const input = { email, code: args.code };
  if (ctx.failedVerifications >= MAX_FAILED_VERIFICATIONS) {
    return {
      result: fail({ code: "IDENTITY_LOCKED", message: "Too many failed verification attempts in this conversation.", retryable: false }),
      effects: {},
    };
  }
  // Per-account lockout across sessions: rotating session ids can't buy more PIN guesses.
  if (deps.verifyGuard && (await deps.verifyGuard.failures(input.email)) >= MAX_ACCOUNT_FAILURES) {
    return {
      result: fail({
        code: "IDENTITY_LOCKED",
        message: "Too many failed verification attempts for this account. Please try again later or ask for a human.",
        retryable: false,
      }),
      effects: {},
    };
  }
  const user = deps.customers.findByEmail(input.email);
  // Already verified for this account in this session: don't re-check the PIN (the model only sees it redacted).
  const alreadyVerified = !!user && ctx.customer?.customerId === user.customerId;
  if (!user || (!alreadyVerified && user.supportPin !== input.code.trim())) {
    await deps.verifyGuard?.recordFailure(input.email);
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
        message: `The email and support PIN don't match our records (attempt ${attempts} of ${MAX_FAILED_VERIFICATIONS}). The email is kept for this conversation: ask only for the PIN again, then call verify_identity with email null and the new code.`,
        retryable: true,
      }),
      effects: { failedVerification: true },
    };
  }

  return {
    result: { ok: true, data: await accountView(user, deps, alreadyVerified) },
    effects: { verified: { customerId: user.customerId, tier: user.tier, contractStatus: user.contractStatus } },
  };
}

/**
 * What the model may know about a verified account. Data minimisation: no name, email or PIN.
 * Policy limits are not included: policy questions go through get_policy (grounded, cited).
 */
export async function accountView(user: CustomerRecord, deps: ToolDeps, alreadyVerified = false): Promise<VerifyOutput> {
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
  return {
    customer_id: user.customerId,
    tier: user.tier,
    contract_status: user.contractStatus,
    contract_end: user.contractEnd,
    already_verified: alreadyVerified,
    invoices,
  };
}

// ---------- get_policy ----------

export async function getPolicy(
  input: { question: string },
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<ToolResult<PolicyOutput>> {
  const tier = ctx.customer?.tier ?? null;
  const answer = await deps.policy.search(input.question, tier, ctx.trace);
  if (answer.status === "needs_escalation") {
    // The guardrail escalated: this is a handoff, not just a suggestion. Verified customers get a ticket now.
    if (ctx.customer) {
      const ticket = await openTicket(
        {
          reason: "low_confidence",
          summary: `Question the knowledge base couldn't answer reliably (${answer.reason}, confidence ${answer.confidence}): ${input.question}`,
        },
        ctx,
        deps,
      );
      return {
        ok: true,
        data: {
          ...answer,
          tier_scope: tier ?? "general",
          ticket,
          next_step: `Tell the customer you couldn't answer this reliably and have handed it to a person: ticket ${ticket.ticketNumber} (${ticket.priority}), first response within ${ticket.responseTarget}. Don't create another ticket.`,
        },
      };
    }
    return {
      ok: true,
      data: {
        ...answer,
        tier_scope: "general",
        next_step: "Tell the customer you can't answer this reliably and offer to hand it to a person; opening a ticket needs their email and support PIN.",
      },
    };
  }
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
  // A refund is only ever issued because the customer asked for one (never on the model's initiative).
  if (ctx.refundRequested === false) {
    return fail({ code: "REFUND_NOT_REQUESTED", message: "The customer hasn't asked for a refund in this conversation. Ask what they need instead.", retryable: false });
  }

  // Authorize against the account as it is now: tier and contract may have changed since verification.
  const record = deps.customers.get(customer.customerId);
  if (!record) return fail({ code: "NOT_VERIFIED", message: "The verified account could not be found.", retryable: false });
  const current = { customerId: record.customerId, tier: record.tier, contractStatus: record.contractStatus };
  const invoice = record.invoices.find((i) => i.invoiceId === input.invoice_id);
  const amountCents = Math.round(input.amount_usd * 100);
  const key = hash("refund", ctx.sessionId, input.invoice_id, amountCents);

  // A request that crashed after its write-ahead entry must not hold the invoice forever.
  await deps.ledger.expireStale(customer.customerId, input.invoice_id, key, PENDING_REFUND_EXPIRY_SEC);
  // Write-ahead: the request is recorded before anything is decided or acknowledged.
  const { created, entry } = await deps.ledger.begin({
    idempotencyKey: key,
    sessionId: ctx.sessionId,
    customerId: customer.customerId,
    invoiceId: input.invoice_id,
    amountUsd: input.amount_usd,
  });
  if (!created && entry.idempotencyKey !== key) {
    // Another request (other amount, session or channel) already holds this invoice.
    return fail(
      entry.status === "succeeded"
        ? {
            code: "ALREADY_REFUNDED",
            message: `Invoice ${input.invoice_id} has already been refunded ($${entry.amountUsd}); only one refund is allowed per invoice.`,
            retryable: false,
          }
        : {
            code: "REFUND_IN_PROGRESS",
            message: `Another refund for invoice ${input.invoice_id} is already being processed. Nothing new was started.`,
            retryable: true,
          },
    );
  }
  if (!created && entry.status === "succeeded") {
    return { ok: true, data: { ...asReceipt(entry.result), replayed: true } };
  }
  if (!created && entry.status === "rejected") {
    return { ok: false, error: asToolError(entry.result) };
  }

  const alreadyRefundedUsd = (invoice?.refundedUsd ?? 0) + (await deps.ledger.refundedUsd(customer.customerId, input.invoice_id));
  const violation = evaluateRefund({ customer: current, invoice, amountUsd: input.amount_usd, alreadyRefundedUsd, now: deps.now() });
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
  // Simulated processor crash AFTER the request was recorded (ledger entry stays pending).
  // A retry with the same key resumes this entry, so it can never refund twice.
  if (activeFault() === "tool_failure") throw new Error("Simulated payment processor failure after the request was recorded");
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
