/**
 * Resets demo state from a developer machine (DATABASE_URL): refunds and tickets for the demo
 * accounts. Same logic as the daily cron route (lib/db/demo-reset.ts), which only Vercel's cron can call.
 * Usage: npm run demo:reset           (asks for confirmation)
 *        npm run demo:reset -- --yes  (no prompt)
 */
import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { neon } from "@neondatabase/serverless";
import { DEMO_CUSTOMER_IDS, DEMO_INVOICE_COUNT, resetDemoData } from "../lib/db/demo-reset";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
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

  const { ledgerEntries, tickets } = await resetDemoData(neon(url));
  console.log(`database:  ${host}`);
  console.log(`deleted:   ${ledgerEntries} ledger entries, ${tickets} tickets`);
  console.log(`customers: ${DEMO_CUSTOMER_IDS.length} demo accounts, ${DEMO_INVOICE_COUNT} invoices (from data/mock_users.json)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
