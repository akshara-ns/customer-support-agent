/**
 * Integration (live Neon): the database enforces one active refund per invoice, so concurrent
 * requests with different idempotency keys can't both start. Uses a throwaway customer id and
 * deletes its own rows. Skipped without DATABASE_URL.
 */
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { pgLedger } from "@/lib/tools/pg-stores";

const live = Boolean(process.env.DATABASE_URL);
const CUSTOMER = "cus_test_ledger_race";
const SESSION = "33333333-3333-4333-8333-333333333333";

describe.skipIf(!live)("pgLedger (live DB)", () => {
  afterAll(async () => {
    await db()`DELETE FROM actions WHERE customer_id = ${CUSTOMER}`;
  });

  it("two concurrent begins on the same invoice with different keys: exactly one is created", async () => {
    await db()`INSERT INTO sessions (id) VALUES (${SESSION}) ON CONFLICT (id) DO NOTHING`;
    const invoiceId = `inv_race_${Date.now()}`;
    const begin = (key: string, amountUsd: number) =>
      pgLedger.begin({ idempotencyKey: `${invoiceId}:${key}`, sessionId: SESSION, customerId: CUSTOMER, invoiceId, amountUsd });
    const results = await Promise.all([begin("a", 100), begin("b", 74), begin("c", 10)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)!.entry.idempotencyKey;
    for (const r of results.filter((x) => !x.created)) expect(r.entry.idempotencyKey).toBe(winner); // losers see the holder
  });

  it("a rejected request frees the invoice for a later valid one", async () => {
    const invoiceId = `inv_free_${Date.now()}`;
    const first = await pgLedger.begin({ idempotencyKey: `${invoiceId}:big`, sessionId: SESSION, customerId: CUSTOMER, invoiceId, amountUsd: 900 });
    await pgLedger.complete(first.entry.idempotencyKey, "rejected", { code: "OVER_TIER_LIMIT" });
    const second = await pgLedger.begin({ idempotencyKey: `${invoiceId}:ok`, sessionId: SESSION, customerId: CUSTOMER, invoiceId, amountUsd: 100 });
    expect(second.created).toBe(true);
  });
});
