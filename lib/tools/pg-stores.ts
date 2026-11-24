import "server-only";
import { db } from "@/lib/db/client";
import { answerWithGuardrails } from "@/lib/guardrails/pipeline";
import type { ActionLedger, LedgerEntry, PolicySearch, TicketStore } from "@/lib/tools/stores";

interface ActionRow {
  idempotency_key: string;
  session_id: string;
  customer_id: string;
  invoice_id: string;
  amount_usd: string;
  status: LedgerEntry["status"];
  result: unknown;
}

const toEntry = (r: ActionRow): LedgerEntry => ({
  idempotencyKey: r.idempotency_key,
  sessionId: r.session_id,
  customerId: r.customer_id,
  invoiceId: r.invoice_id,
  amountUsd: Number(r.amount_usd),
  status: r.status,
  result: r.result,
});

export const pgLedger: ActionLedger = {
  async begin(e) {
    const sql = db();
    const inserted = (await sql`
      INSERT INTO actions (idempotency_key, session_id, customer_id, action_type, status, invoice_id, amount_usd, request)
      VALUES (${e.idempotencyKey}, ${e.sessionId}, ${e.customerId}, 'refund', 'pending', ${e.invoiceId}, ${e.amountUsd},
              ${JSON.stringify({ invoice_id: e.invoiceId, amount_usd: e.amountUsd })}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key, session_id, customer_id, invoice_id, amount_usd, status, result`) as ActionRow[];
    if (inserted[0]) return { created: true, entry: toEntry(inserted[0]) };
    const existing = (await sql`
      SELECT idempotency_key, session_id, customer_id, invoice_id, amount_usd, status, result
      FROM actions WHERE idempotency_key = ${e.idempotencyKey}`) as ActionRow[];
    return { created: false, entry: toEntry(existing[0]) };
  },
  async complete(key, status, result) {
    const rows = await db()`
      UPDATE actions SET status = ${status}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
      WHERE idempotency_key = ${key} AND status = 'pending'
      RETURNING id`;
    if (rows.length !== 1) throw new Error(`ledger entry ${key} was not pending`);
  },
  async refundedUsd(customerId, invoiceId) {
    const rows = (await db()`
      SELECT coalesce(sum(amount_usd), 0) AS total FROM actions
      WHERE customer_id = ${customerId} AND invoice_id = ${invoiceId} AND status = 'succeeded'`) as { total: string }[];
    return Number(rows[0]?.total ?? 0);
  },
};

export const pgTickets: TicketStore = {
  async create(t) {
    const sql = db();
    const inserted = (await sql`
      INSERT INTO tickets (idempotency_key, session_id, customer_id, tier, contract_status, reason, priority, summary)
      VALUES (${t.idempotencyKey}, ${t.sessionId}, ${t.customerId}, ${t.tier}, ${t.contractStatus}, ${t.reason}, ${t.priority}, ${t.summary})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING ticket_number`) as { ticket_number: string }[];
    if (inserted[0]) return { ticketNumber: inserted[0].ticket_number, replayed: false };
    const existing = (await sql`SELECT ticket_number FROM tickets WHERE idempotency_key = ${t.idempotencyKey}`) as {
      ticket_number: string;
    }[];
    return { ticketNumber: existing[0].ticket_number, replayed: true };
  },
};

/** get_policy backend: the calibrated retrieval + grounding pipeline from phase 2. */
export const guardedPolicySearch: PolicySearch = {
  async search(question, tier, trace) {
    const r = await answerWithGuardrails({ query: question, tier: tier ?? undefined, generalOnly: tier === null }, trace);
    if (r.decision.escalate || !r.answer) {
      return {
        status: "needs_escalation",
        reason: r.decision.escalate ? r.decision.reason : "no_answer",
        confidence: Math.round(r.decision.confidence * 1000) / 1000,
      };
    }
    return {
      status: "answered",
      answer: r.answer,
      citations: r.grounding?.citations.cited ?? [],
      confidence: Math.round(r.decision.confidence * 1000) / 1000,
    };
  },
};
