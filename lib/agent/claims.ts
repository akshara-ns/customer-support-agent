/**
 * Claim check: a reply may only claim actions that a tool result in this turn shows.
 * Runs per sentence while the reply streams, so nothing false reaches the customer.
 */
import type { RefundReceipt, Ticket, ToolError } from "@/lib/tools/types";

export interface TurnActions {
  refunds: RefundReceipt[];
  refundErrors: ToolError[];
  tickets: Ticket[];
}

export interface SentenceCheck {
  text: string;
  corrected: boolean;
  reason?: string;
}

const NEGATED = /\b(not|n't|unable|cannot|can't|couldn't|won't|wasn't|isn't|haven't|hasn't|no refund|no ticket)\b|\bif\b|\bonce\b/i;
const REFUND_DONE =
  /\b(refund\w*|reimburs\w*)\b[^.!?]*\b(has been|have been|was|is now|is being|been)\s+(issued|processed|approved|completed|sent|initiated)\b|\b(i|we)(['’]ve| have)?\s+(issued|processed|approved|refunded|initiated|sent)\b[^.!?]*\b(refund|\$)/i;
/** "Refund approved and issued", "your refund is processed". Plural "Refunds are issued…" is policy text, not a claim. */
const REFUND_SINGULAR_DONE = /\brefund\b(?!s)[^.!?]*\b(approved|issued|processed|completed|initiated|sent)\b/i;
const TICKET_DONE =
  /\b(ticket|escalation|case)\b[^.!?]*\b(has been|have been|was|is now|been)\s+(created|opened|raised|filed|logged|submitted)\b|\b(i|we)(['’]ve| have)?\s+(created|opened|raised|filed|logged|submitted|escalated)\b/i;
const TICKET_ID = /\bESC-\d+\b/g;
const AMOUNT = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;

export function checkSentence(sentence: string, actions: TurnActions): SentenceCheck {
  const negated = NEGATED.test(sentence);

  // Ticket numbers must be real tickets from this turn.
  const ids = sentence.match(TICKET_ID) ?? [];
  const realIds = new Set(actions.tickets.map((t) => t.ticketNumber));
  if (ids.some((id) => !realIds.has(id))) {
    return { text: ticketTruth(actions), corrected: true, reason: `unknown ticket id ${ids.join(",")}` };
  }
  if (!negated && TICKET_DONE.test(sentence) && actions.tickets.length === 0) {
    return { text: ticketTruth(actions), corrected: true, reason: "claimed a ticket that wasn't created" };
  }

  if (!negated && (REFUND_DONE.test(sentence) || REFUND_SINGULAR_DONE.test(sentence))) {
    if (actions.refunds.length === 0) {
      return { text: refundTruth(actions), corrected: true, reason: "claimed a refund that wasn't issued" };
    }
    const issued = new Set(actions.refunds.map((r) => r.amountUsd));
    const amounts = [...sentence.matchAll(AMOUNT)].map((m) => Number(m[1].replace(/,/g, "")));
    if (amounts.some((a) => !issued.has(a))) {
      return { text: refundTruth(actions), corrected: true, reason: `refund amount ${amounts.join(",")} not issued` };
    }
  }
  return { text: sentence, corrected: false };
}

function refundTruth(a: TurnActions): string {
  if (a.refunds.length) {
    return a.refunds.map((r) => `A refund of $${r.amountUsd} on invoice ${r.invoiceId} has been issued and should arrive in ${r.arrivesIn}.`).join(" ");
  }
  if (a.refundErrors.length) return `No refund has been issued: ${a.refundErrors[a.refundErrors.length - 1].message}`;
  return "No refund has been issued yet.";
}

function ticketTruth(a: TurnActions): string {
  if (a.tickets.length) {
    return a.tickets.map((t) => `Your ticket is ${t.ticketNumber} (priority ${t.priority}); expect a first response within ${t.responseTarget}.`).join(" ");
  }
  return "I haven't created a ticket yet; I can do that if you'd like.";
}

/**
 * Buffers streamed text and releases it one checked sentence at a time.
 */
export class ClaimGate {
  private buffer = "";
  readonly corrections: { original: string; replacement: string; reason: string }[] = [];

  constructor(private readonly actions: () => TurnActions) {}

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    // A sentence ends at . ! ? or a newline followed by whitespace; keep the tail buffered.
    const re = /[^.!?\n]*(?:[.!?]+(?=\s)|\n)\s*/g;
    let consumed = 0;
    for (let m = re.exec(this.buffer); m && m[0].length > 0; m = re.exec(this.buffer)) {
      if (m.index + m[0].length >= this.buffer.length && !/\s$/.test(m[0])) break;
      out.push(this.check(m[0]));
      consumed = m.index + m[0].length;
    }
    this.buffer = this.buffer.slice(consumed);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? [this.check(rest)] : [];
  }

  private check(sentence: string): string {
    const trailing = sentence.match(/\s*$/)?.[0] ?? "";
    const r = checkSentence(sentence.trim(), this.actions());
    if (!r.corrected) return sentence;
    this.corrections.push({ original: sentence.trim(), replacement: r.text, reason: r.reason ?? "" });
    return r.text + (trailing || " ");
  }
}
