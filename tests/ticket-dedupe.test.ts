/** Ticket idempotency: different problems get different tickets; retries of the same request dedupe (senior review). */
import { describe, expect, it } from "vitest";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { executeTool } from "@/lib/tools/registry";
import type { ToolDeps } from "@/lib/tools/stores";
import type { ToolContext } from "@/lib/tools/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const ctx: ToolContext = { sessionId: "s-t", turnId: "t", customer: { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" }, failedVerifications: 0 };
const deps = (): ToolDeps & { tickets: MemoryTickets } => ({ customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation", reason: "x", confidence: 0 }) }, now: () => NOW });
const ticket = (d: ToolDeps, summary: string) => executeTool("create_escalation_ticket", JSON.stringify({ reason: "refund_over_limit", summary }), ctx, d);
const data = (r: Awaited<ReturnType<typeof ticket>>) => (r.name === "create_escalation_ticket" && r.result.ok ? r.result.data : null);
const num = (r: Awaited<ReturnType<typeof ticket>>) => data(r)?.ticketNumber ?? null;

describe("ticket idempotency", () => {
  it("two over-limit requests on different invoices → two tickets", async () => {
    const d = deps();
    const a = await ticket(d, "Customer wants $900 back on inv_2003.");
    const b = await ticket(d, "Customer wants $500 back on inv_2001.");
    expect(num(a)).not.toBe(num(b));
    expect(d.tickets.tickets.size).toBe(2);
  });

  it("a retry of the same request returns the same ticket", async () => {
    const d = deps();
    const a = await ticket(d, "Customer wants $900 back on inv_2003.");
    const b = await ticket(d, "Customer wants $900 back on inv_2003.");
    expect(num(b)).toBe(num(a));
    expect(data(b)?.replayed).toBe(true);
  });

  it("the same invoice with reworded summaries is still one ticket", async () => {
    const d = deps();
    const a = await ticket(d, "Customer wants $900 back on inv_2003.");
    const b = await ticket(d, "Escalating the $900 refund for invoice inv_2003 to billing.");
    expect(num(b)).toBe(num(a));
  });
});
