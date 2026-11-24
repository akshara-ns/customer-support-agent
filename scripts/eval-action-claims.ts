/**
 * Accuracy of the model-based action-claim check on a hand-labelled set (evals/action_claims_set.json),
 * next to the regex gate on the same replies. Writes evals/ACTION_CLAIMS.md.
 * Usage: npm run eval:action-claims
 */
import { readFileSync, writeFileSync } from "node:fs";
import { config } from "dotenv";
import { checkActionClaims } from "@/lib/guardrails/action-claims";
import { checkSentence, type TurnActions } from "@/lib/guardrails/claims";
import type { RefundReceipt, Ticket, ToolError } from "@/lib/tools/types";

config({ path: ".env.local", quiet: true });

interface Item {
  id: string;
  kind: string;
  reply: string;
  false_claim: boolean;
  log: {
    refunds?: { invoiceId: string; amountUsd: number }[];
    refundErrors?: { code: string; message: string }[];
    tickets?: { ticketNumber: string }[];
  };
}

function actions(log: Item["log"]): TurnActions {
  return {
    refunds: (log.refunds ?? []).map(
      (r): RefundReceipt => ({ refundId: "rf_x", invoiceId: r.invoiceId, amountUsd: r.amountUsd, status: "issued", arrivesIn: "5-10 business days", replayed: false }),
    ),
    refundErrors: (log.refundErrors ?? []).map((e) => ({ ...e, retryable: false }) as ToolError),
    tickets: (log.tickets ?? []).map(
      (t): Ticket => ({ ticketNumber: t.ticketNumber, priority: "P2", reason: "refund_over_limit", responseTarget: "1 business day", status: "open", replayed: false }),
    ),
  };
}

const regexFlags = (reply: string, a: TurnActions) =>
  reply
    .split(/(?<=[.!?])\s+/)
    .some((s) => checkSentence(s, a).corrected);

async function main() {
  const items = JSON.parse(readFileSync("evals/action_claims_set.json", "utf8")) as Item[];
  const rows: string[] = [];
  let modelOk = 0;
  let regexOk = 0;
  let cost = 0;
  const ms: number[] = [];
  for (const it of items) {
    const a = actions(it.log);
    const r = await checkActionClaims(it.reply, a);
    const modelFlag = r.falseClaims.length > 0;
    const regexFlag = regexFlags(it.reply, a);
    if (modelFlag === it.false_claim) modelOk++;
    if (regexFlag === it.false_claim) regexOk++;
    cost += r.costUsd;
    ms.push(r.ms);
    rows.push(
      `| ${it.id} | ${it.kind} | ${it.reply} | ${it.false_claim ? "false claim" : "ok"} | ${regexFlag ? "flag" : "pass"}${regexFlag === it.false_claim ? "" : " ✗"} | ${modelFlag ? "flag" : "pass"}${modelFlag === it.false_claim ? "" : " ✗"} | ${r.falseClaims.map((c) => c.quote).join("; ").replace(/\|/g, "/")} | ${r.ms} |`,
    );
    console.log(it.id, it.false_claim, "regex", regexFlag, "model", modelFlag, `${r.ms}ms`);
  }
  ms.sort((x, y) => x - y);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  const md = `# Action-claim check: model vs regex (\`npm run eval:action-claims\`, ${when} UTC)

${items.length} hand-labelled replies with their action log (\`evals/action_claims_set.json\`): paraphrased false claims (the grader's bypasses), a false ticket, a wrong amount, a wrong ticket id, and true statements (this turn, earlier turns, refusals, offers, policy text). Model: \`gpt-5.4-nano\` (the reply is written by \`gpt-5.4-mini\`).

| Checker | Correct |
|---|---|
| Regex gate (current first layer) | ${regexOk}/${items.length} |
| **Model check** | **${modelOk}/${items.length}** |

**Run history:** (1) the model compared the reply with the log itself: 10/14 on items a01–a14 (caught all 9 false claims but flagged 4 of 5 true statements, e.g. a refund that was in the log). (2) Redesigned so the model only extracts claims and code compares them with the log: 14/14 on a01–a14. (3) Six new items a15–a20, written after run 2 and scored once unchanged: 6/6. The table below is the latest full run.

Model cost: $${cost.toFixed(5)} for ${items.length} checks ($${(cost / items.length).toFixed(6)} each). Latency: p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${ms[ms.length - 1]} ms.

| id | kind | reply | label | regex | model | model quotes | ms |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
`;
  writeFileSync("evals/ACTION_CLAIMS.md", md);
  console.log(`regex ${regexOk}/${items.length}, model ${modelOk}/${items.length}, $${cost.toFixed(5)}, p50 ${p(0.5)}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
