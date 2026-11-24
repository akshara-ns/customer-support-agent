/**
 * The visible transcript of a session, rebuilt from the event log: user and assistant messages,
 * with each turn's tool steps and ticket attached to the assistant message that follows them, so a
 * reloaded conversation keeps its step indicators. Pure (unit-tested).
 */
import { toolLabel, type TranscriptLine, type TranscriptStep } from "@/lib/contracts";
import { orderClientReported, type StoredEvent } from "@/lib/session/events";
import { summarizeOutcome } from "@/lib/tools/step";
import type { TicketSummary } from "@/lib/types";

export function buildTranscript(events: StoredEvent[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  // Steps/tickets seen in a turn that haven't been attached to an assistant message yet.
  const pending = new Map<string, { steps: TranscriptStep[]; ticket?: TicketSummary; seq: number; channel: StoredEvent["channel"] }>();
  const take = (turnId: string) => {
    const p = pending.get(turnId);
    pending.delete(turnId);
    return p;
  };

  const ordered = orderClientReported(events);
  // Position in the ordered log (client-reported voice lines sorted by item time), used for the final order.
  const position = new Map(ordered.map((e, i) => [e.seq, i]));
  for (const { seq, turnId, channel, event } of ordered) {
    switch (event.type) {
      case "user_message":
        lines.push({ seq, channel, role: "user", text: event.text });
        break;
      case "tool_result": {
        const p = pending.get(turnId) ?? { steps: [], seq, channel };
        p.steps.push({
          stepId: `${turnId}:${event.toolCallId}`,
          tool: event.name,
          label: toolLabel(event.name),
          status: event.result.ok ? "ok" : "error",
          summary: summarizeOutcome(event),
        });
        if (event.effects.ticket) {
          const t = event.effects.ticket;
          p.ticket = { ticketNumber: t.ticketNumber, priority: t.priority, responseTarget: t.responseTarget };
        }
        pending.set(turnId, p);
        break;
      }
      case "assistant_message": {
        const p = take(turnId);
        lines.push({
          seq,
          channel,
          role: "assistant",
          text: event.text,
          interrupted: event.interrupted,
          ...(p?.steps.length ? { steps: p.steps } : {}),
          ...(p?.ticket ? { ticket: p.ticket } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  // A turn whose tools ran but whose reply was never logged (e.g. a failed turn): still show its steps.
  for (const p of pending.values()) {
    lines.push({ seq: p.seq, channel: p.channel, role: "assistant", text: "", steps: p.steps, ...(p.ticket ? { ticket: p.ticket } : {}) });
  }
  return lines.sort((a, b) => (position.get(a.seq) ?? a.seq) - (position.get(b.seq) ?? b.seq));
}
