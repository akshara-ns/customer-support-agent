/**
 * Claim check: a reply may only claim actions that a tool result in this session shows
 * (earlier turns included, so a true reference to an earlier refund isn't "corrected").
 * Layer 1 (regex) runs per sentence while the reply streams. Layer 2 (a model that extracts claimed
 * actions; see action-claims.ts) runs when a checker is given: from the first sentence that talks about
 * money or tickets the rest of the reply is held, checked once at the end, corrected, then released.
 */
import type { RefundReceipt, Ticket, ToolError } from "@/lib/tools/types";

export interface TurnActions {
  refunds: RefundReceipt[];
  refundErrors: ToolError[];
  tickets: Ticket[];
}

/** Only replies that talk about money or tickets need the model check. */
export const ACTION_VOCABULARY = /\b(refund\w*|reimburs\w*|credit\w*|money|funds|charge\w*|card|ticket|escalat\w*|ESC-\d+|billing team|cancel\w*|specialist|team)\b/i;

/** Layer 2: returns actions the reply claims that the tool log doesn't show. */
export type ActionChecker = (reply: string, actions: TurnActions) => Promise<{ falseClaims: { quote: string; claimed_action: string }[] }>;

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
/**
 * Paraphrases, first person or about the customer's money only ("I've credited $500 back",
 * "your money is on its way back"). Policy text ("plans can be refunded… up to $200") must pass.
 */
const REFUND_PARAPHRASE =
  /\b(i|we)(['’]ve| have)?\s+(credited|reimbursed|refunded|returned|sent)\b|\b(your|the)\s+(money|funds|payment|refund)\b(?!s)[^.!?]*\b(on its way|on the way|being returned|been returned|sent back)\b/i;
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

  if (!negated && (REFUND_DONE.test(sentence) || REFUND_SINGULAR_DONE.test(sentence) || REFUND_PARAPHRASE.test(sentence))) {
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
  /** Sentences held back for the model check (only when a checker is used). */
  private held: string[] = [];
  readonly corrections: { original: string; replacement: string; reason: string }[] = [];

  constructor(
    private readonly actions: () => TurnActions,
    private readonly hold = false,
  ) {}

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    // A sentence ends at . ! ? or a newline followed by whitespace; keep the tail buffered.
    const re = /[^.!?\n]*(?:[.!?]+(?=\s)|\n)\s*/g;
    let consumed = 0;
    for (let m = re.exec(this.buffer); m && m[0].length > 0; m = re.exec(this.buffer)) {
      if (m.index + m[0].length >= this.buffer.length && !/\s$/.test(m[0])) break;
      const checked = this.check(m[0]);
      if (this.hold && (this.held.length || ACTION_VOCABULARY.test(checked))) this.held.push(checked);
      else out.push(checked);
      consumed = m.index + m[0].length;
    }
    this.buffer = this.buffer.slice(consumed);
    return out;
  }

  /** Drops buffered, unreleased text (a failed model attempt that will be retried). */
  discard(): void {
    this.buffer = "";
    this.held = [];
  }

  /** Releases everything without the model check (a short preamble before a tool call). */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    const out = this.held;
    this.held = [];
    return rest.trim() ? [...out, this.check(rest)] : out;
  }

  /**
   * End of the reply: runs the model check on the held sentences, replaces each false claim with the
   * truth from the tool log, and releases them. If the checker fails, the regex-checked text is released.
   */
  async settle(checker?: ActionChecker, onError?: (err: unknown) => void): Promise<string[]> {
    const held = this.flush();
    const text = held.join("");
    if (!checker || !ACTION_VOCABULARY.test(text)) return held;
    let falseClaims: { quote: string; claimed_action: string }[];
    try {
      ({ falseClaims } = await checker(text, this.actions()));
    } catch (err) {
      onError?.(err);
      return held;
    }
    const out = [...held];
    const said = new Set<string>();
    for (const c of falseClaims) {
      const quote = norm(c.quote);
      let i = out.findIndex((s) => norm(s).includes(quote.slice(0, 40)) || (norm(s).length > 8 && quote.includes(norm(s))));
      const truth = c.claimed_action.startsWith("ticket") ? ticketTruth(this.actions()) : refundTruth(this.actions());
      const replacement = said.has(truth) ? "" : `${truth} `;
      said.add(truth);
      if (i < 0) {
        out.push(replacement);
        i = out.length - 1;
      } else {
        out[i] = replacement;
      }
      this.corrections.push({ original: c.quote, replacement: replacement.trim(), reason: `model: ${c.claimed_action}` });
    }
    return out;
  }

  private check(sentence: string): string {
    const trailing = sentence.match(/\s*$/)?.[0] ?? "";
    const r = checkSentence(sentence.trim(), this.actions());
    if (!r.corrected) return sentence;
    this.corrections.push({ original: sentence.trim(), replacement: r.text, reason: r.reason ?? "" });
    return r.text + (trailing || " ");
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
