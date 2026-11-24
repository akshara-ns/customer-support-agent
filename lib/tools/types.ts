import type { Trace } from "@/lib/observability/trace";
import type { ContractStatus, Tier } from "@/lib/types";

export type {
  RefundReceipt,
  Ticket,
  TicketReason,
  ToolEffects,
  ToolError,
  ToolErrorCode,
  ToolName,
  ToolOutcome,
  ToolOutputs,
  ToolResult,
  VerifiedCustomer,
  VerifyOutput,
} from "@/lib/contracts";
import type { VerifiedCustomer } from "@/lib/contracts";

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

/** Per-call context, rebuilt from the session event log before every turn. */
export interface ToolContext {
  sessionId: string;
  turnId: string;
  customer: VerifiedCustomer | null;
  failedVerifications: number;
  /** Turn trace, so tools that call models (get_policy) add their spans and cost to it. */
  trace?: Trace;
  /**
   * Did a customer message in this conversation ask for a refund? Set by the chat turn and the voice
   * bridge; issue_refund refuses when it is false. Undefined (unit tests of the tool alone) skips the check.
   */
  refundRequested?: boolean;
  /** Email from this conversation's last verify_identity attempt, so a retry can send only a new PIN. */
  lastVerifyEmail?: string | null;
}
