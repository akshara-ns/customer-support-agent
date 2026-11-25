/**
 * Demo reset: deletes refunds (actions ledger) and escalation tickets for the demo accounts, plus
 * tickets opened before verification (customer_id NULL). Customers and invoices come from
 * data/mock_users.json, so they need no reset; session logs are append-only and kept.
 * Shared by `npm run demo:reset` and the daily cron route (/api/cron/demo-reset).
 */
import type { NeonQueryFunction } from "@neondatabase/serverless";
import raw from "@/data/mock_users.json";

export const DEMO_CUSTOMER_IDS: string[] = raw.users.map((u) => u.customer_id);
export const DEMO_INVOICE_COUNT: number = raw.users.reduce((n, u) => n + u.invoices.length, 0);

export async function resetDemoData(sql: NeonQueryFunction<false, false>): Promise<{ ledgerEntries: number; tickets: number }> {
  const [actions, tickets] = await sql.transaction((tx) => [
    tx`DELETE FROM actions WHERE customer_id = ANY(${DEMO_CUSTOMER_IDS}) RETURNING id`,
    tx`DELETE FROM tickets WHERE customer_id = ANY(${DEMO_CUSTOMER_IDS}) OR customer_id IS NULL RETURNING ticket_number`,
  ]);
  return { ledgerEntries: actions.length, tickets: tickets.length };
}
