import "server-only";
import { createHash } from "node:crypto";
import { ACCOUNT_LOCK_WINDOW_SEC } from "@/lib/tools/policy";
import { db } from "@/lib/db/client";
import { answerWithGuardrails } from "@/lib/guardrails/pipeline";
import type { ActionLedger, LedgerEntry, PolicySearch, TicketStore, VerifyGuard } from "@/lib/tools/stores";

interface ActionRow {
  idempotency_key: string;
  session_id: string;
  customer_id: string;
  invoice_id: string;
  amount_usd: string;
  status: LedgerEntry["status"];
  result: unknown;
}

const EXPIRED = { code: "REQUEST_EXPIRED", message: "This refund request didn't complete in time and expired. Nothing was refunded.", retryable: true };

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
      ON CONFLICT DO NOTHING
      RETURNING idempotency_key, session_id, customer_id, invoice_id, amount_usd, status, result`) as ActionRow[];
    if (inserted[0]) return { created: true, entry: toEntry(inserted[0]) };
    // Conflict on the idempotency key (a replay) or on the one-active-refund-per-invoice index.
    const existing = (await sql`
      SELECT idempotency_key, session_id, customer_id, invoice_id, amount_usd, status, result
      FROM actions
      WHERE idempotency_key = ${e.idempotencyKey}
         OR (customer_id = ${e.customerId} AND invoice_id = ${e.invoiceId} AND status IN ('pending', 'succeeded'))
      ORDER BY (idempotency_key = ${e.idempotencyKey}) DESC
      LIMIT 1`) as ActionRow[];
    if (!existing[0]) throw new Error("ledger conflict without a matching entry");
    return { created: false, entry: toEntry(existing[0]) };
  },
  async complete(key, status, result) {
    const rows = await db()`
      UPDATE actions SET status = ${status}, result = ${JSON.stringify(result)}::jsonb, completed_at = now()
      WHERE idempotency_key = ${key} AND status = 'pending'
      RETURNING id`;
    if (rows.length !== 1) throw new Error(`ledger entry ${key} was not pending`);
  },
  async expireStale(customerId, invoiceId, exceptKey, maxAgeSec) {
    const rows = await db()`
      UPDATE actions
      SET status = 'rejected',
          idempotency_key = idempotency_key || ':expired:' || id,
          completed_at = now(),
          result = ${JSON.stringify(EXPIRED)}::jsonb
      WHERE customer_id = ${customerId} AND invoice_id = ${invoiceId} AND status = 'pending'
        AND idempotency_key <> ${exceptKey}
        AND created_at < now() - make_interval(secs => ${maxAgeSec})
      RETURNING id`;
    return rows.length;
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

const emailKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);

/** Failed verifications per account in a fixed window, in the shared rate_limits table (emails hashed). */
export const pgVerifyGuard: VerifyGuard = {
  async failures(email) {
    const rows = (await db()`
      SELECT count FROM rate_limits
      WHERE bucket = 'verify_fail' AND key = ${emailKey(email)}
        AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${ACCOUNT_LOCK_WINDOW_SEC}) * ${ACCOUNT_LOCK_WINDOW_SEC})`) as {
      count: number;
    }[];
    return rows[0]?.count ?? 0;
  },
  async recordFailure(email) {
    await db()`
      INSERT INTO rate_limits (bucket, key, window_start, count)
      VALUES ('verify_fail', ${emailKey(email)}, to_timestamp(floor(extract(epoch FROM now()) / ${ACCOUNT_LOCK_WINDOW_SEC}) * ${ACCOUNT_LOCK_WINDOW_SEC}), 1)
      ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = rate_limits.count + 1`;
  },
};
