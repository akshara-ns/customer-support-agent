/**
 * Types shared by the UI and the backend. Keep this file free of runtime imports
 * so client components can import it without pulling in server code.
 */

export type Channel = "chat" | "voice";
export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  channel: Channel;
  content: string;
  createdAt: string;
}

// ---- SSE events streamed from /api/chat ----

export type StepName =
  | "verify_identity"
  | "retrieve_policy"
  | "issue_refund"
  | "create_escalation"
  | "guardrail_check"
  | "generate_answer";

export type SseEvent =
  | { type: "step_started"; stepId: string; step: StepName; label: string }
  | { type: "step_completed"; stepId: string; step: StepName; ok: boolean; durationMs: number; summary?: string }
  | { type: "token"; text: string }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean }
  | { type: "trace"; span: TraceSpan }
  | { type: "done"; turnId: string; escalated: boolean };

export type ErrorCode = "llm_timeout" | "llm_rate_limited" | "tool_failed" | "rate_limited" | "internal";

// ---- Observability ----

export type SpanKind = "agent" | "llm" | "tool" | "retrieval" | "guardrail";

export interface TraceSpan {
  id: string;
  turnId: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  status: "ok" | "error";
  startedAt: string;
  durationMs: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
}

// ---- Health ----

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  pgvector: string | null;
  migrations: number;
  error?: string;
}

export interface HealthResponse {
  status: "ok" | "error";
  db: DbHealth;
  commit: string | null;
  time: string;
}
