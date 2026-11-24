/**
 * Runs the guarded pipeline once over the blind items (v1 held-out + v2) and saves each decision, its
 * confidence level and the full answer with the cited chunk text, for hand-labelling answer correctness
 * (evals/confidence_labels.json). With labels present, writes evals/CONFIDENCE.md: accuracy per level with
 * 95% intervals. Usage: npm run eval:confidence [-- --report-only]
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rate } from "../evals/stats";

interface Item { id: string; split?: string; category: string; tier: string; label: string; query: string }
interface Run { id: string; category: string; label: string; query: string; level: string; reason: string; topScore: number; docMargin: number; answer: string | null; cited: { key: string; text: string }[] }

const RUNS = "evals/confidence_runs.json";
const LABELS = "evals/confidence_labels.json";

async function run(): Promise<void> {
  const { answerWithGuardrails } = await import("@/lib/guardrails/pipeline");
  const read = (p: string) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item);
  const items = [...read("evals/guardrail_set.jsonl").filter((i) => i.split === "test"), ...read("evals/guardrail_set_v2.jsonl")];
  const out: Run[] = [];
  for (const it of items) {
    const r = await answerWithGuardrails({ query: it.query, tier: it.tier as never });
    const cited = (r.grounding?.citations.cited ?? []).map((k) => ({ key: k, text: r.retrieval.chunks.find((c) => c.chunkKey === k)?.content ?? "" }));
    out.push({ id: it.id, category: it.category, label: it.label, query: it.query, level: r.level, reason: r.decision.escalate ? r.decision.reason : "answered", topScore: +r.retrieval.confidence.topScore.toFixed(3), docMargin: +r.docMargin.toFixed(3), answer: r.answer, cited });
    console.log(it.id, r.level, r.decision.escalate ? r.decision.reason : "answered");
  }
  writeFileSync(RUNS, JSON.stringify(out, null, 1));
}

function report(): void {
  const runs = JSON.parse(readFileSync(RUNS, "utf8")) as Run[];
  const labels = JSON.parse(readFileSync(LABELS, "utf8")) as Record<string, { verdict: "correct" | "wrong"; note: string }>;
  const lines: string[] = [];
  const row = (name: string, rs: Run[], correct: (r: Run) => boolean) => `| ${name} | ${rs.length} | ${rate(rs.filter(correct).length, rs.length)} |`;
  const answered = (lvl: string) => runs.filter((r) => r.level === lvl);
  const ok = (r: Run) => labels[r.id]?.verdict === "correct";
  const low = answered("low");
  lines.push(`# Confidence levels: validation on blind items (\`npm run eval:confidence\`, ${new Date().toISOString().slice(0, 10)})`, "");
  lines.push(
    "40 blind items (v1 held-out 10 + v2 30), one pipeline run. **HIGH** = grounded, not trimmed, top-1 ≥ 0.45 and doc-level margin ≥ 0.10 (thresholds chosen on the v1 calibration split only). **MEDIUM** = grounded but weaker or ambiguous retrieval, or partly grounded (answered with a hedge). **LOW** = escalated.",
    "",
    "Answer correctness was labelled by Claude (the coding assistant), not a human. It compared each full answer with the text of the chunks it cited and with the policy documents (`evals/confidence_labels.json`, with a note per item). *Correct* = every statement is right for the customer's tier and the question is answered; *wrong* = anything false or misleading. For LOW, *correct* means escalation was the right call (labelled should_escalate).",
    "",
    "| Level | Items | Correct |",
    "|---|---|---|",
    row("HIGH (answered)", answered("high"), ok),
    row("MEDIUM (answered, hedged)", answered("medium"), ok),
    row("LOW (escalated): escalation was right", low, (r) => r.label === "should_escalate"),
    "",
  );
  lines.push("| id | category | label | level | reason | top-1 | doc margin | verdict | note |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of runs) {
    const l = labels[r.id];
    lines.push(`| ${r.id} | ${r.category} | ${r.label} | ${r.level} | ${r.reason} | ${r.topScore} | ${r.docMargin} | ${r.level === "low" ? (r.label === "should_escalate" ? "right to escalate" : "false escalation") : (l?.verdict ?? "unlabelled")} | ${(l?.note ?? "").replace(/\|/g, "/")} |`);
  }
  writeFileSync("evals/CONFIDENCE.md", lines.join("\n") + "\n");
  console.log(lines.slice(0, 12).join("\n"));
}

(async () => {
  if (!process.argv.includes("--report-only")) await run();
  if (existsSync(LABELS)) report();
  else console.log(`Label ${RUNS} into ${LABELS}, then run with --report-only.`);
})();
