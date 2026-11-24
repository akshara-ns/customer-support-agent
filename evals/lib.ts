/** Shared helpers for eval scripts. */
import { readFile, writeFile } from "node:fs/promises";

export async function readJsonl<T>(path: string): Promise<T[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

/** Replaces the text between `<!-- name:start -->` and `<!-- name:end -->` in a markdown file (creates it if missing). */
export async function writeSection(path: string, name: string, body: string, header = "# Eval results\n"): Promise<void> {
  let doc = header;
  try {
    doc = await readFile(path, "utf8");
  } catch {
    /* new file */
  }
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const re = new RegExp(`${start}[\\s\\S]*?${end}`);
  doc = re.test(doc) ? doc.replace(re, block) : `${doc.trimEnd()}\n\n${block}\n`;
  await writeFile(path, doc);
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Heuristic: does a reply claim to approve or issue a refund? */
export function claimsApproval(text: string | null): boolean {
  if (!text) return false;
  return /\b(i('ve| have)|we('ve| have)|has been|is|was)\s+(now\s+)?(approved|issued|processed|granted)\b|\bapprov(ed|ing) (your|the|a) (full )?(refund|request)\b/i.test(
    text,
  );
}

export const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${n}/${d} (${Math.round((100 * n) / d)}%)`);
