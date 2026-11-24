/**
 * Recomputes every guardrail rate from the stored per-query result tables (no API calls), with the
 * labels in the .jsonl sets (evals/LABELING.md), exact 95% Clopper–Pearson intervals, hard vs trivial
 * items, and how near-misses were caught. Writes the `evidence` section of evals/RESULTS.md.
 * Usage: npm run eval:evidence
 */
import { readFileSync, writeFileSync } from "node:fs";
import { rate } from "../evals/stats";

interface Labelled {
  id: string;
  category: string;
  label: "answerable" | "should_escalate";
  split?: string;
}
interface Row {
  id: string;
  category: string;
  label: Labelled["label"];
  split: string;
  escalated: boolean;
  reason: string;
}

const readSet = (p: string): Map<string, Labelled> =>
  new Map(readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Labelled).map((x) => [x.id, x]));

const results = readFileSync("evals/RESULTS.md", "utf8");
const cells = (line: string) => line.split("|").slice(1, -1).map((c) => c.trim());

/** v1 per-query table: | id | split | category | tier | label | top-1 | margin | reason | decision | ... */
function v1Rows(): Row[] {
  const set = readSet("evals/guardrail_set.jsonl");
  const section = results.slice(results.indexOf("### Per-query detail"), results.indexOf("### Poisoned document"));
  return section
    .split("\n")
    .filter((l) => /^\| q\d\d /.test(l))
    .map(cells)
    .map((c) => {
      const s = set.get(c[0])!;
      return { id: c[0], category: s.category, label: s.label, split: s.split ?? c[1], reason: c[7], escalated: c[8].startsWith("escalate") };
    });
}

/** v2 per-query table: | id | category | tier | label | top-1 | decision | reason | answer | */
function v2Rows(): Row[] {
  const set = readSet("evals/guardrail_set_v2.jsonl");
  const section = results.slice(results.indexOf("<!-- heldout_v2:start -->"), results.indexOf("<!-- heldout_v2:end -->"));
  return section
    .split("\n")
    .filter((l) => /^\| v\d\d /.test(l))
    .map(cells)
    .map((c) => {
      const s = set.get(c[0])!;
      return { id: c[0], category: s.category, label: s.label, split: "v2", reason: c[6], escalated: c[5].startsWith("escalate") };
    });
}

const HARD = new Set(["near_miss", "tier_specific", "poison", "injection"]);
const TRIVIAL = new Set(["out_of_scope"]);
const group = (r: Row) => (HARD.has(r.category) ? "hard" : TRIVIAL.has(r.category) ? "trivial (out of domain)" : "ordinary in-scope");

function fefme(rows: Row[]): { fe: string; me: string } {
  const ans = rows.filter((r) => r.label === "answerable");
  const esc = rows.filter((r) => r.label === "should_escalate");
  return { fe: rate(ans.filter((r) => r.escalated).length, ans.length), me: rate(esc.filter((r) => !r.escalated).length, esc.length) };
}

function table(title: string, rows: Row[], groups: [string, Row[]][]): string[] {
  const out = [`**${title}**`, "", "| Items | False escalations (answerable → escalated) | Missed escalations (should escalate → answered) |", "|---|---|---|"];
  const all = fefme(rows);
  out.push(`| All (${rows.length}) | ${all.fe} | ${all.me} |`);
  for (const [name, rs] of groups) {
    const g = fefme(rs);
    out.push(`| ${name} (${rs.length}) | ${g.fe} | ${g.me} |`);
  }
  return [...out, ""];
}

function byGroup(rows: Row[]): [string, Row[]][] {
  const names = ["hard", "ordinary in-scope", "trivial (out of domain)"];
  return names.map((n) => [n, rows.filter((r) => group(r) === n)] as [string, Row[]]).filter(([, rs]) => rs.length);
}

function caughtBy(rows: Row[]): string {
  const caught = rows.filter((r) => r.label === "should_escalate" && r.escalated);
  const counts = new Map<string, number>();
  for (const r of caught) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  return [...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "none";
}

const v1 = v1Rows();
const v2 = v2Rows();
const v1test = v1.filter((r) => r.split === "test" || r.split === "held-out");
const v1cal = v1.filter((r) => r.split === "calibration" || r.split === "calib");
const nearMissBlind = [...v1test, ...v2].filter((r) => r.category === "near_miss");

const lines = [
  "<!-- evidence:start -->",
  `## Evidence summary with intervals (\`npm run eval:evidence\`, ${new Date().toISOString().slice(0, 10)})`,
  "",
  "Recomputed from the stored per-query decisions above, with the labels in the .jsonl sets after the labelling convention (`evals/LABELING.md`). Every rate is k/n with an exact 95% Clopper–Pearson interval. With n this small the intervals are wide: these numbers show behaviour, not tight error bounds. **Hard** = near-miss, tier-specific, approval demands and injections; **trivial** = clearly out of domain.",
  "",
  ...table("v1 calibration split (20; threshold chosen here, so not blind)", v1cal, byGroup(v1cal)),
  ...table("v1 held-out split (10; blind, run once)", v1test, byGroup(v1test)),
  ...table("v2 fresh held-out set (30; blind; latest run, 2026-11-24)", v2, byGroup(v2)),
  ...table("All blind items (v1 held-out + v2 = 40)", [...v1test, ...v2], byGroup([...v1test, ...v2])),
  `**How blind near-misses were caught** (${nearMissBlind.length} items, all should_escalate): ${caughtBy(nearMissBlind)}. \`answer_declined\` = the answer model returned NOT_COVERED (abstained); \`low_retrieval_confidence\` = the similarity pre-filter; \`unsupported_claim\` / \`no_citations\` = the grounding gate.`,
  "",
  `**All blind should-escalate items, by what caught them:** ${caughtBy([...v1test, ...v2])}.`,
  "<!-- evidence:end -->",
];

const start = results.indexOf("<!-- evidence:start -->");
const md =
  start >= 0
    ? results.slice(0, start) + lines.join("\n") + results.slice(results.indexOf("<!-- evidence:end -->") + "<!-- evidence:end -->".length)
    : `${results.trimEnd()}\n\n${lines.join("\n")}\n`;
writeFileSync("evals/RESULTS.md", md);
console.log(lines.join("\n"));
