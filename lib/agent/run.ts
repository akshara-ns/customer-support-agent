/**
 * One agent turn: rebuild context from the session log → model picks a tool or replies →
 * code runs the tool (preconditions + policy) → repeat, at most MAX_TOOL_STEPS tools → reply
 * streamed through the claim gate. Every step is logged, traced and emitted as an event.
 */
import { ClaimGate, type ActionChecker, type TurnActions } from "@/lib/guardrails/claims";
import { AgentMachine, type AgentState } from "@/lib/agent/machine";
import { ModelError, type AgentModel } from "@/lib/agent/model";
import { GUARDRAILS } from "@/lib/config";
import { DeadlineExceeded, raceDeadline, runWithSignal } from "@/lib/deadline";
import { DEFAULT_RETRY, withRetry } from "@/lib/agent/retry";
import { redact } from "@/lib/observability/redact";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import { Trace } from "@/lib/observability/trace";
import { actionsForTurn, buildContext, deriveState, type EventStore } from "@/lib/session/events";
import { redactText } from "@/lib/observability/redact";
import { runToolStep } from "@/lib/tools/step";
import { TOOL_DEFINITIONS } from "@/lib/tools/registry";
import { REFUND_INTENT } from "@/lib/tools/policy";
import type { ToolDeps } from "@/lib/tools/stores";
import type { ToolContext } from "@/lib/tools/types";
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
  /** Persists the turn's trace before `done` is emitted (so the drawer can read it immediately). */
  traceSink?: (trace: Trace, channel: Channel) => Promise<void>;
  /** Test hook: retry delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Layer-2 action-claim check (model extraction vs the tool log). Without it only the regex layer runs. */
  actionChecker?: ActionChecker;
  /** End-to-end budget for the turn (default GUARDRAILS.turnDeadlineMs); tests shorten it. */
  deadlineMs?: number;
}

/** Streamed before the first tool runs when the model gave no preamble (claim-free by construction). */
export const ACKNOWLEDGMENT = "One moment while I check that. ";

const FALLBACK: Record<string, string> = {
  deadline: "Sorry, this is taking longer than it should.",
  llm_timeout: "Sorry, the assistant took too long to respond.",
  llm_rate_limited: "Sorry, the assistant is busy right now.",
  llm_unavailable: "Sorry, the assistant is unavailable right now.",
  internal: "Sorry, something went wrong on our side.",
};

export interface TurnSummary {
  turnId: string;
  state: "completed" | "escalated" | "failed";
  reply: string;
  toolsCalled: string[];
  actions: TurnActions;
  corrections: { original: string; replacement: string; reason: string }[];
  trace: Trace;
}

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
  const history = await deps.events.list(sessionId);
  const prior = deriveState(history);
  const ctx: ToolContext = {
    sessionId,
    turnId: trace.turnId,
    customer: prior.customer,
    failedVerifications: prior.failedVerifications,
    trace,
    refundRequested:
      REFUND_INTENT.test(input.message) || history.some(({ event }) => event.type === "user_message" && REFUND_INTENT.test(event.text)),
  };
  // The log keeps a redacted copy (no PIN, masked email); the model sees the raw text for this turn only.
  await log({ type: "user_message", text: redactText(input.message) });

  // Seeded with refunds/tickets from earlier turns, so true references to them aren't "corrected".
  const earlier = actionsForTurn(history);
  const actions: TurnActions = { refunds: [...earlier.refunds], refundErrors: [], tickets: [...earlier.tickets] };
  const gate = new ClaimGate(() => actions, Boolean(deps.actionChecker));
  const checker: ActionChecker | undefined = deps.actionChecker
    ? (text, a) =>
        trace.span("guardrail", "action_claim_check", { layer: 2 }, async (s) => {
          const r = await deps.actionChecker!(text, a);
          const u = r as Partial<{ model: string; tokensIn: number; tokensOut: number }>;
          if (u.model) s.usage({ model: u.model, tokensIn: u.tokensIn ?? 0, tokensOut: u.tokensOut ?? 0 });
          s.output(r);
          return r;
        })
    : undefined;
  const toolsCalled: string[] = [];
  let reply = "";
  let iterationText = "";
  let escalated = false;
  let attemptEmitted = 0;
  let ttftMs: number | undefined;
  const turnStart = performance.now();
  const say = (parts: string[]) => {
    for (let text of parts) {
      if (!text) continue;
      // Text from separate model steps (a preamble, then the answer) must not run together ("now.Pro").
      if (/[.!?]$/.test(reply) && /^\S/.test(text)) text = ` ${text}`;
      if (ttftMs === undefined) {
        ttftMs = Math.round(performance.now() - turnStart);
        trace.mark("agent", "first_token", { ms: ttftMs });
      }
      reply += text;
      iterationText += text;
      attemptEmitted++;
      emit({ type: "token", text });
    }
  };

  // One end-to-end deadline: every model call, check and tool step runs under its signal and races it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.deadlineMs ?? GUARDRAILS.turnDeadlineMs);
  const guarded = <T,>(fn: () => Promise<T>) => raceDeadline(runWithSignal(deadline.signal, fn), deadline.signal);

  go("planning");
  try {
    for (let steps = 0; ; ) {
      const toolChoice = steps >= MAX_TOOL_STEPS ? "none" : "auto";
      iterationText = "";
      const messages = buildContext(await deps.events.list(sessionId));
      const current = messages.findLastIndex((m) => m.role === "user");
      if (current >= 0) messages[current] = { role: "user", content: input.message };
      const promptTrace = {
        model: deps.model.name,
        toolChoice,
        tools: TOOL_DEFINITIONS.map((t) => t.function.name),
        // The prompt as sent (system prompt is shown once per session in the drawer), PII redacted.
        messages: redact(messages.slice(-20)),
        omittedMessages: Math.max(0, messages.length - 20),
      };
      const turn = await trace.span("llm", "agent_step", promptTrace, async (s) => {
        const t = await withRetry(
          async () => {
            attemptEmitted = 0;
            return guarded(() => deps.model.complete({ system: SYSTEM_PROMPT, messages, tools: TOOL_DEFINITIONS, toolChoice }, (d) => say(gate.push(d))));
          },
          {
            ...DEFAULT_RETRY,
            sleep: deps.sleep,
            committed: () => attemptEmitted > 0,
            onRetry: ({ attempt, attempts, delayMs, code }) => {
              gate.discard();
              trace.mark("agent", "retry", { attempt, attempts, delayMs, reason: code });
              emit({ type: "retrying", attempt, attempts, delayMs, reason: code });
            },
          },
        );
        s.usage(t.usage);
        s.output({ toolCalls: t.toolCalls.map((c) => ({ name: c.name, arguments: redact(c.arguments) })), text: redact(t.content.slice(0, 500)) });
        return t;
      });

      // First text fast: a tool turn with no preamble gets a short, claim-free acknowledgment before tools run.
      // It is shown to the customer but kept out of the model's context (not stored as the tool-call preamble).
      if (turn.toolCalls.length > 0 && toolChoice !== "none" && steps === 0 && !reply.trim()) {
        say([ACKNOWLEDGMENT]);
        iterationText = iterationText.slice(0, -ACKNOWLEDGMENT.length);
      }

      if (turn.toolCalls.length === 0 || toolChoice === "none") {
        go("checking_claims");
        say(await guarded(() => gate.settle(checker, (err) => trace.mark("guardrail", "action_claim_check_failed", { error: String(err) }))));
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
        // A refund caught by the deadline stays pending and resumes on retry (same idempotency key).
        const { outcome } = await guarded(() => runToolStep({
          sessionId,
          turnId: trace.turnId,
          channel,
          stepId: `${trace.turnId}:${steps}`,
          call,
          preamble: i === 0 ? iterationText.trim() : undefined,
          ctx,
          deps: deps.tools,
          events: deps.events,
          emit,
          trace,
        }));

        // Session state and per-turn facts the claim gate checks against.
        if (outcome.effects.verified) ctx.customer = outcome.effects.verified;
        if (outcome.effects.failedVerification) ctx.failedVerifications++;
        if (outcome.name === "issue_refund") {
          if (outcome.result.ok) actions.refunds.push(outcome.result.data);
          else actions.refundErrors.push(outcome.result.error);
        }
        if (outcome.effects.ticket) {
          actions.tickets.push(outcome.effects.ticket);
          escalated = true;
        }
        // The guardrail escalated (ticket opened, or offered before verification): the turn ends escalated.
        if (outcome.name === "get_policy" && outcome.result.ok && outcome.result.data.status === "needs_escalation") escalated = true;
        go("planning");
      }
    }
    go(escalated ? "escalated" : "completed");
  } catch (err) {
    const timedOut = deadline.signal.aborted || err instanceof DeadlineExceeded;
    const code = timedOut ? "llm_timeout" : err instanceof ModelError ? err.code : "internal";
    const message = timedOut
      ? "This turn ran past its time budget."
      : err instanceof ModelError
        ? err.message
        : "Something went wrong on our side.";
    if (timedOut) trace.mark("agent", "turn_deadline", { ms: deps.deadlineMs ?? GUARDRAILS.turnDeadlineMs });
    console.error("agent turn failed", err);
    machine.fail(message);
    trace.mark("agent", "turn_failed", { code, message });
    emit({ type: "error", code, message, retryable: true });
    // Graceful reply that only states what this turn actually did.
    const done = [
      ...actions.refunds.map((r) => `A refund of $${r.amountUsd} on invoice ${r.invoiceId} was issued.`),
      ...actions.tickets.map((t) => `Ticket ${t.ticketNumber} was created.`),
    ].join(" ");
    const fallback = `${(timedOut ? FALLBACK.deadline : FALLBACK[code]) ?? FALLBACK.internal} ${done ? `${done} ` : "Nothing was changed. "}Please try again in a moment.`;
    gate.flush();
    say([reply ? `\n\n${fallback}` : fallback]);
    await log({ type: "error", code, message });
  }

  clearTimeout(timer);
  const state = machine.state === "escalated" ? "escalated" : machine.state === "completed" ? "completed" : "failed";
  trace.mark("agent", "turn_end", { state, ttftMs, toolsCalled });
  if (deps.traceSink) {
    try {
      await deps.traceSink(trace, channel);
    } catch (err) {
      console.error("trace persist failed", err);
    }
  }
  for (const span of trace.spans) emit({ type: "trace", span });
  emit({ type: "done", turnId: trace.turnId, state, totals: { ...trace.totals(), ttftMs } });
  return { turnId: trace.turnId, state, reply: reply.trim(), toolsCalled, actions, corrections: gate.corrections, trace };
}
