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

export type ErrorCode =
  | "llm_timeout"
  | "llm_rate_limited"
  | "llm_unavailable"
  | "tool_failed"
  | "rate_limited"
  | "invalid_request"
  | "internal";

export interface TicketSummary {
  ticketNumber: string;
  priority: "P1" | "P2" | "P3";
  responseTarget: string;
}

/** Events emitted by one agent turn. The SSE route numbers them (`seq`). */
export type AgentEvent =
  | { type: "step_started"; stepId: string; tool: string; label: string }
  | { type: "step_completed"; stepId: string; tool: string; label: string; ok: boolean; durationMs: number; summary: string }
  | { type: "token"; text: string }
  | { type: "escalation"; kind: "ticket" | "suggested"; reason: string; ticket?: TicketSummary }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean }
  | { type: "trace"; span: TraceSpan }
  | {
      type: "done";
      turnId: string;
      state: "completed" | "escalated" | "failed";
      totals: { durationMs: number; tokensIn: number; tokensOut: number; costUsd: number };
    };

export type SseEvent = AgentEvent & { seq: number };

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

// ---- Customers and policy ----

export const TIERS = ["free", "pro", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];
export type ContractStatus = "active" | "expired" | "suspended";
export type DocType = "policy" | "troubleshooting" | "faq";

// ---- RAG ----

/** A chunk returned by retrieval. `chunkKey` (e.g. "refund-policy#3") is what answers cite. */
export interface RetrievedChunk {
  chunkKey: string;
  docId: string;
  title: string;
  section: string;
  docType: DocType;
  tiers: Tier[];
  content: string;
  /** Cosine similarity, 0..1 (higher is closer). */
  score: number;
  quarantined: boolean;
}

// ---- Guardrails ----

export type EscalationReason =
  | "low_retrieval_confidence"
  | "answer_declined"
  | "no_citations"
  | "invalid_citation"
  | "unsupported_claim"
  | "grounding_check_failed";

export interface Evidence {
  chunkKey: string;
  section: string;
  score: number;
}

/** The guardrail's verdict. The agent and UI branch on `escalate`. */
export type GuardrailDecision =
  | { escalate: false; confidence: number; evidence: Evidence[] }
  | { escalate: true; reason: EscalationReason; confidence: number; evidence: Evidence[]; detail: string };

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
