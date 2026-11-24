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
  { flag: "addresses_agent", re: /(^|\n|\.\s+)\s*(assistant|ai|bot|agent|model|chatbot)\s*:|\b(note|message|instructions?) (to|for) (the )?(support )?(bot|ai|assistant|agent|model|llm)\b/i },
  { flag: "behaviour_override", re: /\b(from now on|going forward|henceforth)\b[^.\n]{0,60}\b(approve|refund|grant|ignore|skip|allow)/i },
  { flag: "skip_checks", re: /\b(skip|bypass|disable|turn off)\b[^.\n]{0,20}\b(checks?|verification|limits?|guardrails?|rules?)\b/i },
  { flag: "encoded_payload", re: /\b(decode|base64|rot13)\b[^.\n]{0,30}\b(follow|execute|run|obey)\b|[A-Za-z0-9+/]{24,}={0,2}/ },
];

export function scanForInjection(text: string): string[] {
  return PATTERNS.filter((p) => p.re.test(text)).map((p) => p.flag);
}

/** Changes whenever the patterns change, so ingest re-scans (and re-quarantines) every chunk. */
export const DETECTOR_VERSION = PATTERNS.map((p) => `${p.flag}:${p.re.source}:${p.re.flags}`).join("|");
