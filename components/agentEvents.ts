/**
 * The UI's message model and the reducer that applies agent events (chat SSE or voice bridge) to a
 * message. Shared by the chat and voice hooks; client-safe.
 */
import type { AgentEvent, ErrorCode, TicketSummary, TraceSpan } from "@/lib/types";

export interface Step {
  stepId: string;
  tool: string;
  label: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps: Step[];
  escalation?: { kind: "ticket" | "suggested"; reason: string; confidence?: number; ticket?: TicketSummary };
  error?: { code: ErrorCode; message: string; retryable: boolean; tool?: string };
  /** Shown while the client resumes a dropped stream from the last event it received. */
  reconnecting?: { attempt: number; after: number };
  /** The stream was resumed after this event number (no gaps, no duplicates). */
  resumedAfter?: number;
  /** Shown while the server retries a transient model error. */
  retrying?: { attempt: number; attempts: number; reason: ErrorCode };
  streaming?: boolean;
  totals?: { durationMs: number; tokensIn: number; tokensOut: number; costUsd: number; ttftMs?: number };
  spans?: TraceSpan[];
  channel?: "chat" | "voice";
  /** Voice: the caller interrupted; text shows only what was (approximately) heard. */
  interrupted?: boolean;
  /** Voice: claims in spoken audio that no tool result backs (audio can't be rewritten). */
  flags?: string[];
}

/** Applies one step/escalation/error event from the agent to a message (chat SSE and voice bridge). */
export function applyAgentEvent(m: ChatMessage, e: AgentEvent): ChatMessage {
  switch (e.type) {
    case "step_started":
      return m.steps.some((s) => s.stepId === e.stepId)
        ? m
        : { ...m, steps: [...m.steps, { stepId: e.stepId, tool: e.tool, label: e.label, status: "running" }] };
    case "step_completed": {
      const exists = m.steps.some((s) => s.stepId === e.stepId);
      const done: Step = { stepId: e.stepId, tool: e.tool, label: e.label, status: e.ok ? "ok" : "error", durationMs: e.durationMs, summary: e.summary };
      return { ...m, steps: exists ? m.steps.map((s) => (s.stepId === e.stepId ? done : s)) : [...m.steps, done] };
    }
    case "escalation":
      return { ...m, escalation: { kind: e.kind, reason: e.reason, confidence: e.confidence, ticket: e.ticket } };
    case "error":
      return { ...m, error: { code: e.code, message: e.message, retryable: e.retryable, tool: e.tool } };
    case "retrying":
      return { ...m, retrying: { attempt: e.attempt, attempts: e.attempts, reason: e.reason } };
    default:
      return m;
  }
}
