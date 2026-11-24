/**
 * Ports the tools depend on. Postgres implementations live in lib/tools/pg-stores.ts;
 * in-memory ones in lib/tools/memory-stores.ts (tests, scenario runs).
 */
import type { Trace } from "@/lib/observability/trace";
import type { Tier } from "@/lib/types";
import type { CustomerRecord, TicketReason } from "@/lib/tools/types";

export interface CustomerDirectory {
  findByEmail(email: string): CustomerRecord | undefined;
  get(customerId: string): CustomerRecord | undefined;
}

export type LedgerStatus = "pending" | "succeeded" | "rejected";

export interface LedgerEntry {
  idempotencyKey: string;
  sessionId: string;
  customerId: string;
  invoiceId: string;
  amountUsd: number;
  status: LedgerStatus;
  result: unknown;
}

/** Write-ahead ledger for account actions. */
export interface ActionLedger {
  /**
   * Records a pending action. If the key already exists, returns that entry. If ANOTHER request
   * already holds this invoice (pending or succeeded), returns that entry instead: at most one
   * active refund per customer invoice (enforced by a unique index in Postgres).
   */
  begin(entry: Omit<LedgerEntry, "status" | "result">): Promise<{ created: boolean; entry: LedgerEntry }>;
  /** Marks a pending action final (throws if it isn't pending). Success is only acknowledged after this resolves. */
  complete(idempotencyKey: string, status: Exclude<LedgerStatus, "pending">, result: unknown): Promise<void>;
  /** Sum of succeeded refunds for one invoice. */
  refundedUsd(customerId: string, invoiceId: string): Promise<number>;
}

export interface NewTicket {
  idempotencyKey: string;
  sessionId: string;
  customerId: string | null;
  tier: Tier | null;
  contractStatus: string | null;
  reason: TicketReason;
  priority: "P1" | "P2" | "P3";
  summary: string;
}

export interface TicketStore {
  /** Idempotent on `idempotencyKey`: a retry returns the existing ticket number. */
  create(t: NewTicket): Promise<{ ticketNumber: string; replayed: boolean }>;
}

export type { PolicyAnswer } from "@/lib/contracts";
import type { PolicyAnswer } from "@/lib/contracts";

export interface PolicySearch {
  /** tier null = unverified caller: only sections that apply to every tier are searched. */
  search(question: string, tier: Tier | null, trace?: Trace): Promise<PolicyAnswer>;
}

/** Failed verification attempts per account, across sessions (brute-force protection). */
export interface VerifyGuard {
  failures(email: string): Promise<number>;
  recordFailure(email: string): Promise<void>;
}

export interface ToolDeps {
  /** Per-account lockout across sessions. Production always sets it; absent = per-session lockout only. */
  verifyGuard?: VerifyGuard;
  customers: CustomerDirectory;
  ledger: ActionLedger;
  tickets: TicketStore;
  policy: PolicySearch;
  now: () => Date;
}
