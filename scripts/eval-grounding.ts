/**
 * Sanity check for the grounding checker: hand-labelled answers (supported vs containing an
 * unsupported claim) are scored by each candidate model. Pick the cheapest model that is
 * right on all but at most one item.
 * Usage: npm run eval:grounding
 */
import { config } from "dotenv";
import { readFile } from "node:fs/promises";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const CANDIDATES = ["gpt-5-nano", "gpt-5.4-nano", "gpt-5.4-mini"];

interface Item {
  id: string;
  supported: boolean;
  kind: string;
  answer: string;
}

interface Outcome {
  id: string;
  predicted: boolean;
  correct: boolean;
}

async function main(): Promise<void> {
  const { checkClaims } = await import("@/lib/guardrails/grounding");
  const { extractCitations } = await import("@/lib/guardrails/citations");
  const { loadCorpus } = await import("@/lib/rag/corpus");
  const { estimateCostUsd } = await import("@/lib/observability/trace");
  const { MODELS } = await import("@/lib/config");
  const { writeSection, mapLimit } = await import("../evals/lib");

  const { items } = JSON.parse(await readFile("evals/grounding_set.json", "utf8")) as { items: Item[] };
  const byId = new Map(items.map((i) => [i.id, i]));
  const chunks = new Map((await loadCorpus()).flatMap((d) => d.chunks).map((c) => [c.chunkKey, c]));

  const results: Record<string, Outcome[]> = {};
  const stats: Record<string, { ms: number[]; cost: number }> = {};
  for (const model of CANDIDATES) {
    const st = { ms: [] as number[], cost: 0 };
    stats[model] = st;
    results[model] = await mapLimit(items, 4, async (it) => {
      const cited = extractCitations(it.answer).map((k) => {
        const c = chunks.get(k);
        if (!c) throw new Error(`${it.id}: unknown chunk ${k}`);
        return c;
      });
      const t0 = performance.now();
      const { claims } = await checkClaims(it.answer, cited, model, (tokensIn, tokensOut) => {
        st.cost += estimateCostUsd({ model, tokensIn, tokensOut });
      });
      st.ms.push(Math.round(performance.now() - t0));
      const predicted = claims.length > 0 && claims.every((c) => c.supported);
      return { id: it.id, predicted, correct: predicted === it.supported };
    });
    console.log(`${model}: ${results[model].filter((r) => r.correct).length}/${items.length}`);
  }

  const lines: string[] = [];
  lines.push(`## Grounding-checker sanity check (\`npm run eval:grounding\`, ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  lines.push("");
  lines.push(
    `${items.length} hand-labelled answers in \`evals/grounding_set.json\`: ${items.filter((i) => i.supported).length} fully supported, ` +
      `${items.filter((i) => !i.supported).length} with an unsupported claim (wrong number, added claim, more permissive than policy, claim taken from the injected instruction). ` +
      `A model is right when it passes exactly the supported ones. Rule: cheapest model with at most one error.`,
  );
  lines.push("");
  lines.push(`| Model | Correct | Passed an unsupported answer | Blocked a supported answer | Median latency | Cost for ${items.length} checks |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const model of CANDIDATES) {
    const r = results[model];
    const passedBad = r.filter((x) => x.predicted && !byId.get(x.id)?.supported).map((x) => x.id);
    const blockedGood = r.filter((x) => !x.predicted && byId.get(x.id)?.supported).map((x) => x.id);
    const ms = [...stats[model].ms].sort((a, b) => a - b);
    const pinned = model === MODELS.groundingCheck ? " (pinned)" : "";
    lines.push(
      `| \`${model}\`${pinned} | ${r.filter((x) => x.correct).length}/${items.length} | ${passedBad.join(", ") || "none"} | ${blockedGood.join(", ") || "none"} | ${ms[Math.floor(ms.length / 2)]} ms | $${stats[model].cost.toFixed(5)} |`,
    );
  }
  lines.push("");
  lines.push(`| id | kind | label | ${CANDIDATES.map((m) => `\`${m}\``).join(" | ")} |`);
  lines.push(`|---|---|---|${CANDIDATES.map(() => "---").join("|")}|`);
  for (const it of items) {
    const cells = CANDIDATES.map((m) => {
      const r = results[m].find((x) => x.id === it.id);
      return r ? `${r.predicted ? "pass" : "block"}${r.correct ? "" : " ✗"}` : "-";
    });
    lines.push(`| ${it.id} | ${it.kind} | ${it.supported ? "supported" : "unsupported"} | ${cells.join(" | ")} |`);
  }
  await writeSection("evals/RESULTS.md", "grounding", lines.join("\n"));
  console.log(lines.join("\n"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
