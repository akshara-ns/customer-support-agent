/**
 * One tool step, shared by the chat loop and the voice tool bridge: emit step_started, log the
 * call, run the executor (validation, preconditions, policy), emit step_completed, log the
 * result, and surface tickets / suggested escalations / tool failures as events.
 */
import type { Trace } from "@/lib/observability/trace";
import type { EventStore } from "@/lib/session/events";
import { toolLabel, type ToolOutcome } from "@/lib/contracts";
import { executeTool, redactArgs } from "@/lib/tools/registry";
import type { ToolDeps } from "@/lib/tools/stores";
import type { Ticket, ToolContext } from "@/lib/tools/types";
import type { AgentEvent, Channel } from "@/lib/types";

export interface ToolCallInput {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolStepArgs {
  sessionId: string;
  turnId: string;
  channel: Channel;
  stepId: string;
  call: ToolCallInput;
  /** Text the model said before calling the tool (chat), logged with the call. */
  preamble?: string;
  ctx: ToolContext;
  deps: ToolDeps;
  events: EventStore;
  emit: (e: AgentEvent) => void;
  trace?: Trace;
}

export function summarizeOutcome(o: ToolOutcome): string {
  if (!o.result.ok) {
    // The UI gets customer-facing text; the model-facing message (with retry instructions) stays internal.
    if (o.result.error.code === "TOOL_FAILURE") return o.name === "issue_refund" ? "Refund failed; nothing was refunded" : "Step failed; nothing was changed";
    if (o.result.error.code === "SERVICE_UNAVAILABLE") return "The knowledge base is temporarily unavailable";
    return o.result.error.message;
  }
  switch (o.name) {
    case "verify_identity":
      return `Verified: ${o.result.data.tier} tier, contract ${o.result.data.contract_status}`;
    case "get_policy":
      if (o.result.data.status === "answered") return `Found policy answer (confidence ${o.result.data.confidence})`;
      if (o.result.data.status === "needs_verification") return "Depends on your plan: verification needed";
      return o.result.data.ticket ? `Not covered reliably: handed to a person (${o.result.data.ticket.ticketNumber})` : "Not covered by policy: escalation offered";
    case "issue_refund":
      return `Refund of $${o.result.data.amountUsd} issued on ${o.result.data.invoiceId}${o.result.data.replayed ? " (already processed)" : ""}`;
    case "create_escalation_ticket":
      return `Ticket ${o.result.data.ticketNumber} created (${o.result.data.priority})`;
    default:
      return "Done";
  }
}

const ticketSummary = (t: Ticket) => ({ ticketNumber: t.ticketNumber, priority: t.priority, responseTarget: t.responseTarget });

/** The model-facing tool output: data or the typed error, nothing else. Same for chat and voice. */

export async function runToolStep(a: ToolStepArgs): Promise<{ outcome: ToolOutcome; durationMs: number }> {
  const log = (event: Parameters<EventStore["append"]>[3]) => a.events.append(a.sessionId, a.turnId, a.channel, event);
  const label = toolLabel(a.call.name);
  a.emit({ type: "step_started", stepId: a.stepId, tool: a.call.name, label });
  await log({
    type: "tool_call",
    toolCallId: a.call.id,
    name: a.call.name,
    arguments: redactArgs(a.call.name, a.call.arguments),
    content: a.preamble || undefined,
  });

  const t0 = performance.now();
  const run = () => executeTool(a.call.name, a.call.arguments, a.ctx, a.deps);
  const redacted = (() => {
    try {
      return JSON.parse(redactArgs(a.call.name, a.call.arguments) || "{}");
    } catch {
      return {};
    }
  })();
  const outcome = a.trace
    ? await a.trace.span("tool", a.call.name, redacted, async (s) => {
        const o = await run();
        s.output(o.result);
        // A typed tool error (refused refund, failed verification…) shows as an error span with its code.
        if (!o.result.ok) s.error(o.result.error.code);
        return o;
      })
    : await run();
  const durationMs = Math.round(performance.now() - t0);

  a.emit({ type: "step_completed", stepId: a.stepId, tool: a.call.name, label, ok: outcome.result.ok, durationMs, summary: summarizeOutcome(outcome) });
  await log({ type: "tool_result", toolCallId: a.call.id, ...outcome });

  const policyEscalation =
    outcome.name === "get_policy" && outcome.result.ok && outcome.result.data.status === "needs_escalation" ? outcome.result.data : null;
  const confidence = policyEscalation?.confidence;
  if (outcome.effects.ticket) {
    const ticket = outcome.effects.ticket;
    // A guardrail escalation reports the guardrail's reason (e.g. low_retrieval_confidence), not the ticket category.
    const reason = policyEscalation?.reason ?? ticket.reason;
    a.emit({ type: "escalation", kind: "ticket", reason, confidence, ticket: ticketSummary(ticket) });
    await log({ type: "escalation", kind: "ticket", reason, confidence, ticket });
  } else if (policyEscalation) {
    // Not verified: the handoff is offered; the ticket needs the customer's identity.
    a.emit({ type: "escalation", kind: "suggested", reason: policyEscalation.reason, confidence });
    await log({ type: "escalation", kind: "suggested", reason: policyEscalation.reason, confidence });
  }
  if (!outcome.result.ok && (outcome.result.error.code === "TOOL_FAILURE" || outcome.result.error.code === "SERVICE_UNAVAILABLE")) {
    const code = outcome.result.error.code === "TOOL_FAILURE" ? "tool_failed" : "retrieval_unavailable";
    a.emit({ type: "error", code, message: outcome.result.error.message, retryable: true, tool: a.call.name });
    await log({ type: "error", code, message: outcome.result.error.message });
  }
  return { outcome, durationMs };
}
