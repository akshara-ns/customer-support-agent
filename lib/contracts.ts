/**
 * Contracts shared by the tools, the agent loop, the voice bridge and the UI. Client-safe: no runtime
 * imports, only types and constant arrays (the types derive from the arrays, so they can't drift).
 */
import type { AgentEvent, Channel, ContractStatus, SpanKind, TicketSummary, Tier } from "@/lib/types";

// ---------- tools ----------

export const TOOL_NAMES = ["verify_identity", "get_policy", "issue_refund", "create_escalation_ticket"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TICKET_REASONS = [
  "refund_over_limit",
  "refund_outside_window",
  "billing_error",
  "account_suspended",
  "low_confidence",
  "customer_request",
  "security",
  "privacy_request",
  "other",
] as const;
export type TicketReason = (typeof TICKET_REASONS)[number];

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_VERIFIED"
  | "VERIFICATION_FAILED"
  | "IDENTITY_LOCKED"
  | "CONTRACT_NOT_ACTIVE"
  | "INVOICE_NOT_FOUND"
  | "CHARGEBACK_FILED"
  | "ALREADY_REFUNDED"
  | "REFUND_IN_PROGRESS"
  | "INVALID_AMOUNT"
  | "AMOUNT_EXCEEDS_INVOICE"
  | "OUTSIDE_REFUND_WINDOW"
  | "OVER_TIER_LIMIT"
  | "TOOL_FAILURE"
  | "SERVICE_UNAVAILABLE";

export interface Ticket {
  ticketNumber: string;
  priority: "P1" | "P2" | "P3";
  reason: TicketReason;
  responseTarget: string;
  status: "open";
  replayed: boolean;
}

export interface ToolError {
  code: ToolErrorCode;
  /** Plain-language reason (model-facing; the UI shows a customer-facing summary). */
  message: string;
  retryable: boolean;
  /** Set when policy says the case should go to a human, with the ticket reason to use. */
  suggestedEscalation?: TicketReason;
  /** Policy requires the escalation now (not just offered): the tool opens the ticket itself. */
  escalationRequired?: boolean;
  /** Ticket opened by the tool for a required escalation. */
  ticket?: Ticket;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

/** What a session knows after verification: the minimum the agent needs. */
export interface VerifiedCustomer {
  customerId: string;
  tier: Tier;
  contractStatus: ContractStatus;
}

export interface VerifyOutput {
  customer_id: string;
  tier: Tier;
  contract_status: ContractStatus;
  contract_end: string | null;
  /** True when this session had already verified this account (no new PIN check). */
  already_verified: boolean;
  invoices: {
    invoice_id: string;
    date: string;
    amount_usd: number;
    description: string;
    refunded_usd: number;
    refundable_until: string;
  }[];
}

export type PolicyAnswer =
  | { status: "answered"; answer: string; citations: string[]; confidence: number }
  | { status: "needs_escalation"; reason: string; confidence: number };

export type PolicyOutput = PolicyAnswer & { tier_scope: Tier | "general" };

export interface RefundReceipt {
  refundId: string;
  invoiceId: string;
  amountUsd: number;
  status: "issued";
  arrivesIn: string;
  replayed: boolean;
}

/** Success payload per tool. */
export interface ToolOutputs {
  verify_identity: VerifyOutput;
  get_policy: PolicyOutput;
  issue_refund: RefundReceipt;
  create_escalation_ticket: Ticket;
}

/** Session-state changes a tool call causes (identity, lockout counter, tickets). */
export interface ToolEffects {
  verified?: VerifiedCustomer;
  failedVerification?: boolean;
  ticket?: Ticket;
}

/** Discriminated by `name`: narrowing on it types `result.data` exactly (no casts downstream). */
export type ToolOutcome =
  | { [K in ToolName]: { name: K; result: ToolResult<ToolOutputs[K]>; effects: ToolEffects } }[ToolName]
  | { name: "unknown_tool"; result: { ok: false; error: ToolError }; effects: ToolEffects };

/** Status lines for the UI's live step indicators. */
export const TOOL_LABELS: Record<ToolName, string> = {
  verify_identity: "Verifying identity and account tier…",
  get_policy: "Searching knowledge base…",
  issue_refund: "Checking refund policy and issuing refund…",
  create_escalation_ticket: "Creating escalation ticket…",
};

export function toolLabel(name: string): string {
  return (TOOL_LABELS as Record<string, string>)[name] ?? name;
}

// ---------- demo failure simulation ----------

export const FAULTS = ["llm_timeout", "llm_rate_limit", "tool_failure", "retrieval_down"] as const;
export type Fault = (typeof FAULTS)[number];
/** Client-only demo fault (the browser drops its own stream). */
export type ClientFault = Fault | "stream_drop";

// ---------- API payloads ----------

export interface VoiceToolResponse {
  /** JSON string for the realtime `function_call_output` item. */
  output: string;
  ok: boolean;
  /** step_started / step_completed / escalation / error, for the UI's step indicators. */
  events: AgentEvent[];
}

export interface VoiceHistoryItem {
  role: "user" | "assistant";
  text: string;
  channel: Channel;
}

export interface VoiceSessionResponse {
  clientSecret: string;
  expiresAt: number;
  model: string;
  verified: boolean;
  history: VoiceHistoryItem[];
  maxSeconds: number;
}

export interface TranscriptStep {
  stepId: string;
  tool: string;
  label: string;
  status: "ok" | "error";
  summary: string;
}

/** One visible line of a reloaded transcript (GET /api/chat?sessionId=…). */
export interface TranscriptLine {
  seq: number;
  channel: Channel;
  role: "user" | "assistant";
  text: string;
  interrupted?: boolean;
  /** Tool steps of the same turn, so reloaded messages keep their step indicators. */
  steps?: TranscriptStep[];
  ticket?: TicketSummary;
}

export interface TranscriptResponse {
  sessionId: string;
  transcript: TranscriptLine[];
}

/** Public demo panel data (fake accounts; PINs shown on purpose so reviewers can try it). */
export interface DemoUser {
  name: string;
  email: string;
  pin: string;
  tier: Tier;
  contractStatus: ContractStatus;
  tryThis: string;
}

// ---------- observability report (GET /api/sessions/:id/traces) ----------

export interface SpanNode {
  id: string;
  kind: SpanKind;
  name: string;
  status: "ok" | "error";
  startMs: number;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  costUsd: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  children: SpanNode[];
}

export interface TurnReport {
  turnId: string;
  channel: Channel;
  startedAt: string;
  durationMs: number;
  ttftMs: number | null;
  state: string | null;
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
  tools: { name: string; durationMs: number; status: string; error?: string }[];
  guardrails: { name: string; detail: unknown }[];
  corrections: unknown[];
  retries: unknown[];
  spans: SpanNode[];
}

export interface SessionReport {
  turns: TurnReport[];
  summary: {
    turns: number;
    chatTurnMs: { p50: number | null; p95: number | null };
    ttftMs: { p50: number | null; p95: number | null };
    voiceResponseMs: { p50: number | null; p95: number | null };
    tokens: { in: number; out: number; cached: number };
    costUsd: { chat: number; voice: number; total: number };
  };
}

export interface TraceReportResponse extends SessionReport {
  sessionId: string;
  systemPrompt: string;
  pricing: { checked: string; source: string; note: string };
}
