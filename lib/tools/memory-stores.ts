/** In-memory stores with the same contracts as the Postgres ones (tests and scenario runs). */
import type { ActionLedger, LedgerEntry, NewTicket, TicketStore, VerifyGuard } from "@/lib/tools/stores";

export class MemoryLedger implements ActionLedger {
  readonly entries = new Map<string, LedgerEntry>();
  /** Order of writes, so tests can assert "recorded before acknowledged". */
  readonly log: string[] = [];
  private readonly createdAt = new Map<string, number>();
  private seq = 0;

  /** `clock` (ms) is injectable so tests can move past the pending expiry. */
  constructor(private readonly clock: () => number = () => Date.now()) {}

  async expireStale(customerId: string, invoiceId: string, exceptKey: string, maxAgeSec: number) {
    let n = 0;
    for (const [key, e] of [...this.entries]) {
      const age = (this.clock() - (this.createdAt.get(key) ?? this.clock())) / 1000;
      if (e.customerId !== customerId || e.invoiceId !== invoiceId || e.status !== "pending" || key === exceptKey || age <= maxAgeSec) continue;
      // Same as pgLedger: mark rejected and retire the key so a later retry starts fresh.
      const retired = `${key}:expired:${++this.seq}`;
      this.entries.delete(key);
      this.entries.set(retired, {
        ...e,
        idempotencyKey: retired,
        status: "rejected",
        result: { code: "REQUEST_EXPIRED", message: "This refund request didn't complete in time and expired. Nothing was refunded.", retryable: true },
      });
      this.log.push(`expire:${key}`);
      n++;
    }
    return n;
  }

  async begin(e: Omit<LedgerEntry, "status" | "result">) {
    const existing = this.entries.get(e.idempotencyKey);
    if (existing) return { created: false, entry: existing };
    // Same rule as the Postgres unique index: one active (pending/succeeded) refund per invoice.
    const active = [...this.entries.values()].find(
      (x) => x.customerId === e.customerId && x.invoiceId === e.invoiceId && x.status !== "rejected",
    );
    if (active) return { created: false, entry: active };
    const entry: LedgerEntry = { ...e, status: "pending", result: null };
    this.entries.set(e.idempotencyKey, entry);
    this.createdAt.set(e.idempotencyKey, this.clock());
    this.log.push(`begin:${e.idempotencyKey}`);
    return { created: true, entry };
  }

  async complete(key: string, status: "succeeded" | "rejected", result: unknown) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`no ledger entry ${key}`);
    if (entry.status !== "pending") throw new Error(`ledger entry ${key} was not pending`); // same contract as pgLedger
    entry.status = status;
    entry.result = result;
    this.log.push(`complete:${status}:${key}`);
  }

  async refundedUsd(customerId: string, invoiceId: string) {
    let sum = 0;
    for (const e of this.entries.values()) {
      if (e.customerId === customerId && e.invoiceId === invoiceId && e.status === "succeeded") sum += e.amountUsd;
    }
    return sum;
  }
}

export class MemoryTickets implements TicketStore {
  readonly tickets = new Map<string, NewTicket & { ticketNumber: string }>();
  private next = 1001;

  async create(t: NewTicket) {
    const existing = this.tickets.get(t.idempotencyKey);
    if (existing) return { ticketNumber: existing.ticketNumber, replayed: true };
    const ticketNumber = `ESC-${this.next++}`;
    this.tickets.set(t.idempotencyKey, { ...t, ticketNumber });
    return { ticketNumber, replayed: false };
  }
}

export class MemoryVerifyGuard implements VerifyGuard {
  readonly counts = new Map<string, number>();
  async failures(email: string, source: string) {
    const e = email.trim().toLowerCase();
    return { source: this.counts.get(`${e}|${source}`) ?? 0, account: this.counts.get(e) ?? 0 };
  }
  async recordFailure(email: string, source: string) {
    const e = email.trim().toLowerCase();
    for (const k of [e, `${e}|${source}`]) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }
}
