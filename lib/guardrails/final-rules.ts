/**
 * Pure helpers for final-reply grounding (see final-reply.ts and lib/agent/run.ts): the records a reply
 * may rely on, the deterministic reply when the guardrail is run in code, and dropping unsupported sentences.
 */
import type { Fact } from "@/lib/guardrails/final-reply";
import { locate, splitSentences } from "@/lib/guardrails/partial";
import type { StoredEvent } from "@/lib/session/events";
import type { ToolOutcome } from "@/lib/tools/types";

/** What our systems returned in this conversation: grounded policy answers, refunds, tickets, the account view. */
export function factsFromEvents(events: StoredEvent[]): Fact[] {
  const facts: Fact[] = [];
  for (const { event } of events) {
    if (event.type !== "tool_result") continue;
    const id = `${event.name}:${event.toolCallId}`;
    if (event.result.ok) {
      const data = event.result.data as unknown;
      if (event.name === "get_policy") {
        const d = data as { status: string; answer?: string };
        if (d.status === "answered" && d.answer) facts.push({ id, content: d.answer });
        else facts.push({ id, content: JSON.stringify(d) });
      } else {
        facts.push({ id, content: JSON.stringify(data) });
      }
    } else {
      facts.push({ id, content: `${event.name} refused (${event.result.error.code}): ${event.result.error.message}` });
    }
  }
  return facts;
}

const stripCitations = (s: string) => s.replace(/\s*\[[a-z0-9-]+#\d+\]/g, "").trim();

/** The customer-facing reply when code ran get_policy because the model's reply wasn't grounded. */
export function replyForPolicyOutcome(o: ToolOutcome): string {
  if (o.name !== "get_policy") return "I couldn't confirm that from our records.";
  if (!o.result.ok) return "I couldn't check our documentation just now. Nothing was changed; please try again in a moment.";
  const d = o.result.data;
  if (d.status === "answered") return stripCitations(d.answer);
  if (d.status === "needs_verification") return "That depends on your plan. Please share your account email and 6-digit support PIN so I can answer for your plan.";
  if (d.ticket) {
    return `I can't answer that reliably, so I've handed it to a person: ticket ${d.ticket.ticketNumber} (${d.ticket.priority}), first response within ${d.ticket.responseTarget}.`;
  }
  return "I can't answer that reliably. I can hand it to a person; to open a ticket I'll need your account email and support PIN.";
}

export const UNCONFIRMED_NOTE = "I couldn't confirm anything beyond that from our records.";

/** Removes the sentences that carry unsupported claims; null if a claim can't be placed (caller falls back). */
export function dropUnsupported(text: string, unsupported: string[]): { text: string; removed: string[] } | null {
  const sentences = splitSentences(text);
  const drop = new Set<number>();
  for (const claim of unsupported) {
    const i = locate(claim, sentences);
    if (i < 0) return null;
    drop.add(i);
  }
  const kept = sentences.filter((_, i) => !drop.has(i));
  return { text: kept.length ? `${kept.join(" ")} ${UNCONFIRMED_NOTE}` : "", removed: sentences.filter((_, i) => drop.has(i)) };
}

/**
 * The model sometimes repeats a sentence verbatim ("X\nX", seen in its raw output). Collapses immediate
 * repeats; returns the text unchanged when there are none.
 */
export function collapseRepeatedSentences(text: string): string {
  const parts = text.split(/(?<=[.!?])(\s+)/);
  const out: string[] = [];
  let last = "";
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? "";
    const key = sentence.trim().toLowerCase();
    if (key && key === last) continue;
    out.push(sentence + sep);
    if (key) last = key;
  }
  const collapsed = out.join("");
  return collapsed.trim() === text.trim() ? text : collapsed.replace(/\s+$/, "") + (/\s$/.test(text) ? " " : "");
}

