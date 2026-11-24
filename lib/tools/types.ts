import type { Trace } from "@/lib/observability/trace";
import type { ContractStatus, Tier } from "@/lib/types";

export type ToolName = "verify_identity" | "get_policy" | "issue_refund" | "create_escalation_ticket";

export type ToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_VERIFIED"
  | "VERIFICATION_FAILED"
  | "IDENTITY_LOCKED"
  | "CONTRACT_NOT_ACTIVE"
  | "INVOICE_NOT_FOUND"
  | "CHARGEBACK_FILED"
  | "ALREADY_REFUNDED"
  | "INVALID_AMOUNT"
  | "AMOUNT_EXCEEDS_INVOICE"
  | "OUTSIDE_REFUND_WINDOW"
  | "OVER_TIER_LIMIT"
  | "TOOL_FAILURE";

export type TicketReason =
  | "refund_over_limit"
  | "refund_outside_window"
  | "billing_error"
  | "account_suspended"
  | "low_confidence"
  | "customer_request"
  | "security"
  | "privacy_request"
  | "other";

export interface ToolError {
  code: ToolErrorCode;
  /** Plain-language reason, safe to show the customer. */
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

export interface Invoice {
  invoiceId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  amountUsd: number;
  description: string;
  refundedUsd: number;
  chargeback: boolean;
}

/** Full record in the mock CRM. Never sent to the model as a whole. */
export interface CustomerRecord {
  customerId: string;
  name: string;
  email: string;
  supportPin: string;
  tier: Tier;
  contractStatus: ContractStatus;
  contractEnd: string | null;
  invoices: Invoice[];
}

/** What a session knows after verification: the minimum the agent needs. */
export interface VerifiedCustomer {
  customerId: string;
  tier: Tier;
  contractStatus: ContractStatus;
}

export interface Ticket {
  ticketNumber: string;
  priority: "P1" | "P2" | "P3";
  reason: TicketReason;
  responseTarget: string;
  status: "open";
  replayed: boolean;
}

export interface RefundReceipt {
  refundId: string;
  invoiceId: string;
  amountUsd: number;
  status: "issued";
  arrivesIn: string;
  replayed: boolean;
}

/** Per-call context, rebuilt from the session event log before every turn. */
export interface ToolContext {
  sessionId: string;
  turnId: string;
  customer: VerifiedCustomer | null;
  failedVerifications: number;
  /** Turn trace, so tools that call models (get_policy) add their spans and cost to it. */
  trace?: Trace;
}
