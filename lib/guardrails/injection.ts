/**
 * Ingest-time scan for instruction-like text inside knowledge-base documents.
 * Flagged chunks are stored but quarantined: retrieval excludes them by default, so they
 * can never raise a confidence score or be cited. This is one layer; the others are the
 * data-only prompt framing (answer + grounding prompts) and policy checks in tool code.
 */

const PATTERNS: { flag: string; re: RegExp }[] = [
  { flag: "override_instructions", re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|earlier)\b[^.\n]{0,20}\b(instructions?|rules?|limits?|polic(y|ies)|prompts?)\b/i },
  { flag: "addresses_ai", re: /\b(system (instruction|prompt|message)|instructions? for (ai|the assistant|assistants|llms?)|ai assistants?:|you are (now )?an? (ai|assistant))\b/i },
  { flag: "forced_approval", re: /\b(approve|grant|issue)\b[^.\n]{0,30}\b(any|all|every)\b[^.\n]{0,30}\b(refunds?|requests?)\b/i },
  { flag: "suppress_escalation", re: /\b(do not|don't|never)\s+escalate\b/i },
];

export function scanForInjection(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.flag);
}
