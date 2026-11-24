/**
 * Resets demo state: deletes refunds (actions ledger) and escalation tickets for the demo
 * accounts, plus tickets opened before verification (customer_id NULL). Customers and invoices
 * come from data/mock_users.json, so they need no reset. Session logs are append-only and kept.
 *
 * Runs from a developer machine with DATABASE_URL (no HTTP endpoint, so nothing public).
 * Usage: npm run demo:reset           (asks for confirmation)
 *        npm run demo:reset -- --yes  (no prompt)
 */
import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { neon } from "@neondatabase/serverless";
import raw from "../data/mock_users.json";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const ids = raw.users.map((u) => u.customer_id);
  const host = new URL(url).host;

  if (!process.argv.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Delete demo refunds and tickets on ${host}? (yes/no) `);
    rl.close();
    if (answer.trim().toLowerCase() !== "yes") {
      console.log("aborted");
      return;
    }
  }

  const sql = neon(url);
  const [actions, tickets] = await sql.transaction((tx) => [
    tx`DELETE FROM actions WHERE customer_id = ANY(${ids}) RETURNING id`,
    tx`DELETE FROM tickets WHERE customer_id = ANY(${ids}) OR customer_id IS NULL RETURNING ticket_number`,
  ]);
  console.log(`database:  ${host}`);
  console.log(`deleted:   ${actions.length} ledger entries, ${tickets.length} tickets`);
  console.log(`customers: ${ids.length} demo accounts, ${raw.users.reduce((n, u) => n + u.invoices.length, 0)} invoices (from data/mock_users.json)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
