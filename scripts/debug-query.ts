/**
 * Runs one query through the full guardrail pipeline and prints the draft, grounding claims and decision.
 * Usage: npm run debug:query -- "<question>" [free|pro|enterprise]
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

async function main(): Promise<void> {
  const [query, tier] = process.argv.slice(2);
  if (!query) throw new Error('usage: npm run debug:query -- "<question>" [tier]');
  const { answerWithGuardrails } = await import("@/lib/guardrails/pipeline");
  const r = await answerWithGuardrails({
    query,
    tier: tier as "free" | "pro" | "enterprise" | undefined,
    forceGenerate: true,
  });
  console.log("decision:", JSON.stringify(r.decision, null, 2));
  console.log("draft:", r.draft);
  console.log("claims:", JSON.stringify(r.grounding?.claims ?? null, null, 2));
  console.log("totals:", r.trace.totals());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
