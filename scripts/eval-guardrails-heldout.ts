/**
 * Fresh held-out check of the guardrail at the CURRENT threshold and rule (no sweep, no tuning).
 * Runs every query once through the full guardrail; reports false and missed escalations overall and
 * per category, next to the original held-out result.
 * Usage: npm run eval:heldout   (reads evals/guardrail_set_v2.jsonl, writes a section of evals/RESULTS.md)
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

interface Item {
  id: string;
  category: string;
  tier: "free" | "pro" | "enterprise" | null;
  label: "answerable" | "should_escalate";
  query: string;
  expect_doc?: string;
}

async function main(): Promise<void> {
  const { answerWithGuardrails } = await import("@/lib/guardrails/pipeline");
  const { GUARDRAILS, MODELS } = await import("@/lib/config");
  const { readJsonl, writeSection, mapLimit, pct } = await import("../evals/lib");
  const items = await readJsonl<Item>("evals/guardrail_set_v2.jsonl");

  const rows = await mapLimit(items, 6, async (it) => {
    const r = await answerWithGuardrails({ query: it.query, tier: it.tier ?? undefined });
    process.stdout.write(".");
    return {
      ...it,
      escalated: r.decision.escalate,
      reason: r.decision.escalate ? r.decision.reason : "answered",
      top1: r.retrieval.confidence.topScore,
      hit: it.expect_doc ? r.retrieval.chunks.some((c) => c.docId === it.expect_doc) : null,
      answer: r.answer,
      cost: r.trace.totals().costUsd,
    };
  });
  console.log();

  const rate = (list: typeof rows) => {
    const ans = list.filter((r) => r.label === "answerable");
    const esc = list.filter((r) => r.label === "should_escalate");
    return { fe: pct(ans.filter((r) => r.escalated).length, ans.length), me: pct(esc.filter((r) => !r.escalated).length, esc.length) };
  };
  const cats = [...new Set(rows.map((r) => r.category))];
  const lines: string[] = [];
  lines.push(`## Fresh held-out set v2 (\`npm run eval:heldout\`, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  lines.push("");
  lines.push(
    `30 NEW labelled queries (\`evals/guardrail_set_v2.jsonl\`, written after the threshold was fixed), 6 per category. Run once at the unchanged threshold **${GUARDRAILS.similarityThreshold}** and rule, with no tuning. Models: answers \`${MODELS.answer}\`, grounding \`${MODELS.groundingCheck}\`.`,
  );
  lines.push("");
  const all = rate(rows);
  lines.push(`| Set | False escalations (answerable but escalated) | Missed escalations (should escalate but answered) |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Original held-out (10 queries, run 2, last blind) | 1/6 (17%) | 0/4 (0%) |`);
  lines.push(`| **Fresh held-out v2 (30 queries)** | **${all.fe}** | **${all.me}** |`);
  for (const c of cats) {
    const r = rate(rows.filter((x) => x.category === c));
    lines.push(`| v2: ${c} | ${r.fe} | ${r.me} |`);
  }
  lines.push("");
  const exp = rows.filter((r) => r.expect_doc);
  lines.push(
    `Retrieval recall@5 on v2 answerable queries: ${pct(exp.filter((r) => r.hit).length, exp.length)}. Cost of this run: $${rows.reduce((a, r) => a + r.cost, 0).toFixed(4)}.`,
  );
  lines.push("");
  lines.push(`| id | category | tier | label | top-1 | decision | reason | answer (first 140 chars) |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const wrong = r.escalated === (r.label === "answerable") ? " ✗" : "";
    lines.push(
      `| ${r.id} | ${r.category} | ${r.tier ?? "-"} | ${r.label} | ${r.top1.toFixed(3)} | ${r.escalated ? "escalate" : "answer"}${wrong} | ${r.reason} | ${(r.answer ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 140)} |`,
    );
  }
  await writeSection("evals/RESULTS.md", "heldout_v2", lines.join("\n"));
  console.log(lines.slice(0, 14).join("\n"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
