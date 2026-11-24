/**
 * The session event log: one append-only, numbered sequence per session, shared by chat
 * and voice. Agent context and verified-identity state are rebuilt from it every turn.
 */
import type { RefundReceipt, Ticket, ToolError, ToolOutcome, VerifiedCustomer } from "@/lib/contracts";
import type { Channel, ErrorCode } from "@/lib/types";

export type SessionEvent =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string; corrections?: string[]; interrupted?: boolean }
  | { type: "tool_call"; toolCallId: string; name: string; arguments: string; content?: string }
  | ({ type: "tool_result"; toolCallId: string } & ToolOutcome)
  | { type: "escalation"; kind: "ticket" | "suggested"; reason: string; ticket?: Ticket }
  | { type: "error"; code: ErrorCode; message: string };

export interface StoredEvent {
  seq: number;
  turnId: string;
  channel: Channel;
  createdAt: string;
  event: SessionEvent;
}

export interface EventStore {
  ensureSession(sessionId: string): Promise<void>;
  append(sessionId: string, turnId: string, channel: Channel, event: SessionEvent): Promise<StoredEvent>;
  list(sessionId: string): Promise<StoredEvent[]>;
}

export interface SessionState {
  customer: VerifiedCustomer | null;
  failedVerifications: number;
}

export function deriveState(events: StoredEvent[]): SessionState {
  let customer: VerifiedCustomer | null = null;
  let failedVerifications = 0;
  for (const { event } of events) {
    if (event.type !== "tool_result") continue;
    if (event.effects.verified) customer = event.effects.verified;
    if (event.effects.failedVerification) failedVerifications++;
  }
  return { customer, failedVerifications };
}

export type ContextMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Compact tool result for the model: data or the typed error, nothing else. */
function toolContent(o: ToolOutcome): string {
  return JSON.stringify(o.result.ok ? { ok: true, data: o.result.data } : { ok: false, error: o.result.error });
}

/**
 * Rebuilds chat context from the log. Keeps the most recent `maxEvents`, trimmed forward to
 * a user message so a tool call is never separated from its result.
 */
export function buildContext(events: StoredEvent[], maxEvents = 60): ContextMessage[] {
  let start = Math.max(0, events.length - maxEvents);
  while (start > 0 && start < events.length && events[start].event.type !== "user_message") start++;
  const window = events.slice(start);
  const results = new Map<string, Extract<SessionEvent, { type: "tool_result" }>>();
  for (const { event } of window) if (event.type === "tool_result") results.set(event.toolCallId, event);
  const out: ContextMessage[] = [];
  for (const { event } of window) {
    switch (event.type) {
      case "user_message":
        out.push({ role: "user", content: event.text });
        break;
      case "assistant_message":
        out.push({ role: "assistant", content: event.text });
        break;
      case "tool_call": {
        // Emit each call immediately followed by its result (voice can log a transcript in between);
        // a call without a recorded result is dropped.
        const result = results.get(event.toolCallId);
        if (!result) break;
        out.push({
          role: "assistant",
          content: event.content || null,
          tool_calls: [{ id: event.toolCallId, type: "function", function: { name: event.name, arguments: event.arguments } }],
        });
        out.push({ role: "tool", tool_call_id: event.toolCallId, content: toolContent(result) });
        break;
      }
      default:
        break; // escalation and error events are for the UI and audit, not the model
    }
  }
  return out;
}

export class MemoryEventStore implements EventStore {
  readonly sessions = new Map<string, StoredEvent[]>();
  async ensureSession(sessionId: string) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, []);
  }
  async append(sessionId: string, turnId: string, channel: Channel, event: SessionEvent) {
    const list = this.sessions.get(sessionId) ?? [];
    const stored: StoredEvent = { seq: list.length + 1, turnId, channel, createdAt: new Date().toISOString(), event };
    list.push(stored);
    this.sessions.set(sessionId, list);
    return stored;
  }
  async list(sessionId: string) {
    return [...(this.sessions.get(sessionId) ?? [])];
  }
}

/**
 * Refunds, refusals and tickets from tool results (for the claim check). With `turnId`, only that
 * turn; without, the whole session. Refusals are only kept for the given turn.
 */
export function actionsForTurn(events: StoredEvent[], turnId?: string): {
  refunds: RefundReceipt[];
  refundErrors: ToolError[];
  tickets: Ticket[];
} {
  const out: { refunds: RefundReceipt[]; refundErrors: ToolError[]; tickets: Ticket[] } = { refunds: [], refundErrors: [], tickets: [] };
  for (const e of events) {
    if ((turnId !== undefined && e.turnId !== turnId) || e.event.type !== "tool_result") continue;
    const ev = e.event;
    if (ev.name === "issue_refund") {
      if (ev.result.ok) out.refunds.push(ev.result.data);
      else if (turnId !== undefined) out.refundErrors.push(ev.result.error);
    }
    if (ev.effects.ticket) out.tickets.push(ev.effects.ticket);
  }
  return out;
}
