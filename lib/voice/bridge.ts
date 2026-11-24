/**
 * Voice ↔ backend bridge. Tool calls from the realtime model run through the SAME tool step as
 * chat (lib/agent/tool-step.ts); transcripts and usage go into the same session log and traces.
 */
import { ACTION_VOCABULARY, ClaimGate, type ActionChecker } from "@/lib/guardrails/claims";
import { runToolStep, toolOutputForModel } from "@/lib/tools/step";
import { REALTIME_PRICING_PER_MTOK } from "@/lib/config";
import { actionsForTurn, deriveState, type EventStore } from "@/lib/session/events";
import type { ToolDeps } from "@/lib/tools/stores";
import { Trace } from "@/lib/observability/trace";
import { redactText } from "@/lib/observability/redact";
import type { VoiceToolResponse } from "@/lib/contracts";
import type { AgentEvent, SpanKind } from "@/lib/types";

export interface VoiceToolRequest {
  sessionId: string;
  turnId: string;
  callId: string;
  name: string;
  arguments: string;
}

export type { VoiceToolResponse } from "@/lib/contracts";

export async function runVoiceTool(
  req: VoiceToolRequest,
  deps: { events: EventStore; tools: ToolDeps; traceSink?: (trace: Trace, channel: "voice") => Promise<void> },
): Promise<VoiceToolResponse> {
  await deps.events.ensureSession(req.sessionId);
  const state = deriveState(await deps.events.list(req.sessionId));
  const emitted: AgentEvent[] = [];
  const trace = new Trace(req.turnId);
  const { outcome } = await runToolStep({
    sessionId: req.sessionId,
    turnId: req.turnId,
    channel: "voice",
    stepId: `${req.turnId}:${req.callId}`,
    call: { id: req.callId, name: req.name, arguments: req.arguments },
    ctx: { sessionId: req.sessionId, turnId: req.turnId, customer: state.customer, failedVerifications: state.failedVerifications, trace },
    deps: deps.tools,
    events: deps.events,
    emit: (e) => emitted.push(e),
    trace,
  });
  if (deps.traceSink) await deps.traceSink(trace, "voice").catch((err) => console.error("voice trace persist failed", err));
  return { output: toolOutputForModel(outcome), ok: outcome.result.ok, events: emitted };
}

export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; cached_tokens?: number };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Estimated cost of one realtime response from its usage block (missing fields count as 0). */
export function realtimeCostUsd(model: string, u: RealtimeUsage): number {
  const p = REALTIME_PRICING_PER_MTOK[model];
  if (!p) return 0;
  const inD = u.input_token_details ?? {};
  const outD = u.output_token_details ?? {};
  const cached = inD.cached_tokens ?? 0;
  const audioIn = inD.audio_tokens ?? 0;
  const textIn = Math.max(0, (inD.text_tokens ?? 0) - cached);
  return (
    (audioIn * p.audioIn + textIn * p.textIn + cached * p.cachedIn + (outD.audio_tokens ?? 0) * p.audioOut + (outD.text_tokens ?? 0) * p.textOut) /
    1_000_000
  );
}

export type VoiceEvent =
  | { kind: "user_transcript"; text: string }
  | { kind: "assistant_transcript"; text: string; interrupted: boolean }
  | { kind: "usage"; model: string; usage: RealtimeUsage; responseId?: string; latencyMs?: number };

export interface TraceWriter {
  write(row: {
    sessionId: string;
    turnId: string;
    kind: SpanKind;
    name: string;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    costUsd: number;
    output: unknown;
  }): Promise<void>;
}

/**
 * Appends a voice transcript or usage record. Assistant transcripts are claim-checked against this
 * turn's tool results: audio already spoken can't be rewritten, so mismatches are flagged instead.
 */
export async function recordVoiceEvent(
  sessionId: string,
  turnId: string,
  ev: VoiceEvent,
  deps: { events: EventStore; traces: TraceWriter; actionChecker?: ActionChecker },
): Promise<{ flags: string[]; costUsd?: number }> {
  await deps.events.ensureSession(sessionId);
  if (ev.kind === "user_transcript") {
    await deps.events.append(sessionId, turnId, "voice", { type: "user_message", text: redactText(ev.text) });
    return { flags: [] };
  }
  if (ev.kind === "assistant_transcript") {
    const events = await deps.events.list(sessionId);
    const session = actionsForTurn(events);
    const turn = actionsForTurn(events, turnId);
    const actions = { refunds: session.refunds, tickets: session.tickets, refundErrors: turn.refundErrors };
    const gate = new ClaimGate(() => actions);
    gate.push(ev.text);
    gate.flush();
    const flags = gate.corrections.map((c) => `${c.reason}: "${c.original}"`);
    if (flags.length) {
      await deps.traces.write({ sessionId, turnId, kind: "guardrail", name: "claim_check", tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, output: { channel: "voice", flags } });
    }
    // Layer 2 (model extraction) when the regex found nothing; spoken audio can't be rewritten, so it flags.
    if (!flags.length && deps.actionChecker && ACTION_VOCABULARY.test(ev.text)) {
      try {
        const r = (await deps.actionChecker(ev.text, actions)) as Awaited<ReturnType<ActionChecker>> &
          Partial<{ model: string; tokensIn: number; tokensOut: number; costUsd: number; ms: number }>;
        for (const c of r.falseClaims) {
          flags.push(`model: ${c.claimed_action}: "${c.quote}"`);
          gate.corrections.push({ original: c.quote, replacement: "", reason: `model: ${c.claimed_action}` });
        }
        await deps.traces.write({
          sessionId,
          turnId,
          kind: "guardrail",
          name: "action_claim_check",
          tokensIn: r.tokensIn ?? 0,
          tokensOut: r.tokensOut ?? 0,
          tokensCached: 0,
          costUsd: r.costUsd ?? 0,
          output: { channel: "voice", model: r.model, falseClaims: r.falseClaims, ms: r.ms },
        });
      } catch {
        // Fail open to the regex result: the flag is advisory for audio already spoken.
      }
    }
    await deps.events.append(sessionId, turnId, "voice", {
      type: "assistant_message",
      text: ev.text,
      interrupted: ev.interrupted,
      corrections: gate.corrections.map((c) => c.reason),
    });
    return { flags };
  }
  const costUsd = realtimeCostUsd(ev.model, ev.usage);
  await deps.traces.write({
    sessionId,
    turnId,
    kind: "llm",
    name: `realtime_response:${ev.model}`,
    tokensIn: ev.usage.input_tokens ?? 0,
    tokensOut: ev.usage.output_tokens ?? 0,
    tokensCached: ev.usage.input_token_details?.cached_tokens ?? 0,
    costUsd,
    output: { responseId: ev.responseId, usage: ev.usage, latencyMs: ev.latencyMs },
  });
  return { flags: [], costUsd };
}
