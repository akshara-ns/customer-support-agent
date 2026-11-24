/**
 * One agent turn: rebuild context from the session log → model picks a tool or replies →
 * code runs the tool (preconditions + policy) → repeat, at most MAX_TOOL_STEPS tools → reply
 * streamed through the claim gate. Every step is logged, traced and emitted as an event.
 */
import { ClaimGate, type TurnActions } from "@/lib/agent/claims";
import { AgentMachine, type AgentState } from "@/lib/agent/machine";
import { ModelError, type AgentModel } from "@/lib/agent/model";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { Trace } from "@/lib/observability/trace";
import { buildContext, deriveState, type EventStore } from "@/lib/session/events";
import { TOOL_DEFINITIONS, TOOL_LABELS, executeTool, isToolName, redactArgs, type ToolOutcome } from "@/lib/tools/registry";
import type { ToolDeps } from "@/lib/tools/stores";
import type { RefundReceipt, Ticket, ToolContext } from "@/lib/tools/types";
import type { AgentEvent, Channel } from "@/lib/types";

export const MAX_TOOL_STEPS = 6;

export interface TurnInput {
  sessionId: string;
  message: string;
  channel: Channel;
}

export interface TurnDeps {
  model: AgentModel;
  tools: ToolDeps;
  events: EventStore;
}

export interface TurnSummary {
  turnId: string;
  state: "completed" | "escalated" | "failed";
  reply: string;
  toolsCalled: string[];
  actions: TurnActions;
  corrections: { original: string; replacement: string; reason: string }[];
  trace: Trace;
}

function summarize(o: ToolOutcome): string {
  if (!o.result.ok) return o.result.error.message;
  const d = o.result.data as Record<string, unknown>;
  switch (o.name) {
    case "verify_identity":
      return `Verified: ${d.tier} tier, contract ${d.contract_status}`;
    case "get_policy":
      return d.status === "answered" ? `Found policy answer (confidence ${d.confidence})` : "Not covered by policy: escalation suggested";
    case "issue_refund":
      return `Refund of $${d.amountUsd} issued on ${d.invoiceId}${d.replayed ? " (already processed)" : ""}`;
    case "create_escalation_ticket":
      return `Ticket ${d.ticketNumber} created (${d.priority})`;
  }
}

const toSummary = (t: Ticket) => ({ ticketNumber: t.ticketNumber, priority: t.priority, responseTarget: t.responseTarget });

export async function runTurn(input: TurnInput, deps: TurnDeps, emit: (e: AgentEvent) => void): Promise<TurnSummary> {
  const trace = new Trace();
  const machine = new AgentMachine();
  const go = (to: AgentState, note?: string) => {
    const from = machine.state;
    machine.to(to, note);
    trace.mark("agent", `${from} → ${to}`, note ? { note } : undefined);
  };
  const { sessionId, channel } = input;
  const log = (event: Parameters<EventStore["append"]>[3]) => deps.events.append(sessionId, trace.turnId, channel, event);

  await deps.events.ensureSession(sessionId);
  const prior = deriveState(await deps.events.list(sessionId));
  const ctx: ToolContext = {
    sessionId,
    turnId: trace.turnId,
    customer: prior.customer,
    failedVerifications: prior.failedVerifications,
    trace,
  };
  await log({ type: "user_message", text: input.message });

  const actions: TurnActions = { refunds: [], refundErrors: [], tickets: [] };
  const gate = new ClaimGate(() => actions);
  const toolsCalled: string[] = [];
  let reply = "";
  let iterationText = "";
  let escalated = false;
  const say = (parts: string[]) => {
    for (const text of parts) {
      reply += text;
      iterationText += text;
      emit({ type: "token", text });
    }
  };

  go("planning");
  try {
    for (let steps = 0; ; ) {
      const toolChoice = steps >= MAX_TOOL_STEPS ? "none" : "auto";
      iterationText = "";
      const messages = buildContext(await deps.events.list(sessionId));
      const turn = await trace.span("llm", "agent_step", { model: deps.model.name, toolChoice, messages: messages.length }, async (s) => {
        const t = await deps.model.complete({ system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS, toolChoice }, (d) => say(gate.push(d)));
        s.usage(t.usage);
        s.output({ toolCalls: t.toolCalls.map((c) => c.name), cachedTokens: t.usage.cachedTokens, text: t.content.slice(0, 300) });
        return t;
      });

      if (turn.toolCalls.length === 0 || toolChoice === "none") {
        go("checking_claims");
        say(gate.flush());
        if (gate.corrections.length) trace.mark("guardrail", "claim_check", { corrections: gate.corrections });
        go("responding");
        await log({ type: "assistant_message", text: iterationText.trim(), corrections: gate.corrections.map((c) => c.reason) });
        break;
      }

      say(gate.flush()); // a preamble ("Let me check that.") ends where the tool call starts
      for (const [i, call] of turn.toolCalls.entries()) {
        steps++;
        toolsCalled.push(call.name);
        go("executing_tool", call.name);
        const stepId = `${trace.turnId}:${steps}`;
        const label = isToolName(call.name) ? TOOL_LABELS[call.name] : call.name;
        emit({ type: "step_started", stepId, tool: call.name, label });
        await log({
          type: "tool_call",
          toolCallId: call.id,
          name: call.name,
          arguments: redactArgs(call.name, call.arguments),
          content: i === 0 ? iterationText.trim() || undefined : undefined,
        });

        const t0 = performance.now();
        const outcome = await trace.span("tool", call.name, JSON.parse(redactArgs(call.name, call.arguments) || "{}"), async (s) => {
          const o = await executeTool(call.name, call.arguments, ctx, deps.tools);
          s.output(o.result);
          return o;
        });
        const durationMs = Math.round(performance.now() - t0);
        emit({ type: "step_completed", stepId, tool: call.name, label, ok: outcome.result.ok, durationMs, summary: summarize(outcome) });
        await log({ type: "tool_result", toolCallId: call.id, name: outcome.name, result: outcome.result, effects: outcome.effects });

        // Session state and per-turn facts the claim gate checks against.
        if (outcome.effects.verified) ctx.customer = outcome.effects.verified;
        if (outcome.effects.failedVerification) ctx.failedVerifications++;
        if (outcome.name === "issue_refund") {
          if (outcome.result.ok) actions.refunds.push(outcome.result.data as RefundReceipt);
          else actions.refundErrors.push(outcome.result.error);
        }
        if (outcome.effects.ticket) {
          const ticket = outcome.effects.ticket;
          actions.tickets.push(ticket);
          escalated = true;
          emit({ type: "escalation", kind: "ticket", reason: ticket.reason, ticket: toSummary(ticket) });
          await log({ type: "escalation", kind: "ticket", reason: ticket.reason, ticket });
        }
        if (outcome.name === "get_policy" && outcome.result.ok && (outcome.result.data as { status: string }).status === "needs_escalation") {
          const reason = String((outcome.result.data as { reason: string }).reason);
          emit({ type: "escalation", kind: "suggested", reason });
          await log({ type: "escalation", kind: "suggested", reason });
        }
        if (!outcome.result.ok && outcome.result.error.code === "TOOL_FAILURE") {
          emit({ type: "error", code: "tool_failed", message: outcome.result.error.message, retryable: true });
          await log({ type: "error", code: "tool_failed", message: outcome.result.error.message });
        }
        go("planning");
      }
    }
    go(escalated ? "escalated" : "completed");
  } catch (err) {
    const code = err instanceof ModelError ? err.code : "internal";
    const message = err instanceof ModelError ? err.message : "Something went wrong on our side.";
    console.error("agent turn failed", err);
    machine.fail(message);
    trace.mark("agent", "turn_failed", { code, message });
    emit({ type: "error", code, message, retryable: true });
    // Graceful reply that only states what this turn actually did.
    const done = [
      ...actions.refunds.map((r) => `A refund of $${r.amountUsd} on invoice ${r.invoiceId} was issued.`),
      ...actions.tickets.map((t) => `Ticket ${t.ticketNumber} was created.`),
    ].join(" ");
    const fallback = `Sorry, I'm having trouble responding right now. ${done ? `${done} ` : ""}Please try again in a moment.`;
    gate.flush();
    say([reply ? `\n\n${fallback}` : fallback]);
    await log({ type: "error", code, message });
  }

  for (const span of trace.spans) emit({ type: "trace", span });
  const state = machine.state === "escalated" ? "escalated" : machine.state === "completed" ? "completed" : "failed";
  emit({ type: "done", turnId: trace.turnId, state, totals: trace.totals() });
  return { turnId: trace.turnId, state, reply: reply.trim(), toolsCalled, actions, corrections: gate.corrections, trace };
}
