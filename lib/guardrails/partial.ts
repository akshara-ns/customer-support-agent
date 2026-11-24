/**
 * Partial grounding: when only side details of an answer are unsupported, remove the sentences that
 * carry them and answer with the rest, instead of escalating a mostly-correct answer. Escalation stays
 * if an unsupported claim answers the question itself, if a claim can't be placed in a sentence, or if
 * nothing cited and supported is left. Pure code; the claim checker provides `answers_question`.
 */
import { checkCitations } from "@/lib/guardrails/citations";

export interface CheckedClaim {
  claim: string;
  supported: boolean;
  /** From the claim checker; missing is treated as true (conservative). */
  answers_question?: boolean;
}

export interface PartialAnswer {
  text: string;
  removed: string[];
}

/** The note appended when something was removed, so the customer knows the answer is partial. */
export const PARTIAL_NOTE = "I couldn't confirm the other details in our documentation, so I've left them out; I can pass that part to a person if you need it.";

/** Sentence split that keeps citations written after the period ("…days.[doc#1] Next…") with their sentence. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?](?:\s*\[[a-z0-9-]+#\d+\])*)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const STOP = new Set("a an the and or of to in on for is are be with your you it this that at as by from can if".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/\[[^\]]+\]/g, " ").match(/[a-z0-9$]+/g)?.filter((w) => !STOP.has(w)) ?? []);

/** Index of the sentence that best contains the claim, or -1 if none overlaps enough. */
export function locate(claim: string, sentences: string[]): number {
  const c = words(claim);
  if (!c.size) return -1;
  let best = -1;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    const w = words(s);
    let hit = 0;
    for (const x of c) if (w.has(x)) hit++;
    const score = hit / c.size;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 0.5 ? best : -1;
}

export function trimUnsupported(answer: string, claims: CheckedClaim[], retrievedKeys: string[]): PartialAnswer | null {
  const unsupported = claims.filter((c) => !c.supported);
  const supported = claims.filter((c) => c.supported);
  if (!unsupported.length) return null;
  if (unsupported.some((c) => c.answers_question !== false)) return null; // the question itself isn't grounded
  if (!supported.some((c) => c.answers_question !== false)) return null; // nothing that answers the question is left
  const sentences = splitSentences(answer);
  const drop = new Set<number>();
  for (const c of unsupported) {
    const i = locate(c.claim, sentences);
    if (i < 0) return null; // can't tell where the unsupported claim is: escalate rather than guess
    drop.add(i);
  }
  const kept = sentences.filter((_, i) => !drop.has(i));
  // Every supported claim that answers the question must survive the cut.
  for (const c of supported) {
    if (c.answers_question === false) continue;
    if (locate(c.claim, kept) < 0) return null;
  }
  const text = `${kept.join(" ")} ${PARTIAL_NOTE}`;
  if (!checkCitations(text, retrievedKeys).ok) return null;
  return { text, removed: sentences.filter((_, i) => drop.has(i)) };
}
