/** In-memory stores with the same contracts as the Postgres ones (tests and scenario runs). */
import type { ActionLedger, LedgerEntry, NewTicket, TicketStore } from "@/lib/tools/stores";

export class MemoryLedger implements ActionLedger {
  readonly entries = new Map<string, LedgerEntry>();
  /** Order of writes, so tests can assert "recorded before acknowledged". */
  readonly log: string[] = [];

  async begin(e: Omit<LedgerEntry, "status" | "result">) {
    const existing = this.entries.get(e.idempotencyKey);
    if (existing) return { created: false, entry: existing };
    const entry: LedgerEntry = { ...e, status: "pending", result: null };
    this.entries.set(e.idempotencyKey, entry);
    this.log.push(`begin:${e.idempotencyKey}`);
    return { created: true, entry };
  }

  async complete(key: string, status: "succeeded" | "rejected", result: unknown) {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`no ledger entry ${key}`);
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
