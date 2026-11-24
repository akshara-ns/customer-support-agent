/** Pure citation checks: every answer must cite chunk keys, and only ones that were retrieved. */

const CITATION = /\[([a-z0-9-]+#\d+)\]/g;

export function extractCitations(answer: string): string[] {
  return [...new Set([...answer.matchAll(CITATION)].map((m) => m[1]))];
}

export interface CitationCheck {
  ok: boolean;
  cited: string[];
  /** Cited keys that are not in the retrieved set (fabricated or out of scope). */
  invalid: string[];
}

export function checkCitations(answer: string, retrievedKeys: Iterable<string>): CitationCheck {
  const allowed = new Set(retrievedKeys);
  const cited = extractCitations(answer);
  const invalid = cited.filter((k) => !allowed.has(k));
  return { ok: cited.length > 0 && invalid.length === 0, cited, invalid };
}
