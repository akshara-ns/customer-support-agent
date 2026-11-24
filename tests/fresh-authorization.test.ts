/**
 * issue_refund authorizes against the account as it is now, not as it was at verification
 * (senior review: stale authorization). The verified-customer snapshot only identifies the account.
 */
import { describe, expect, it } from "vitest";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { executeTool } from "@/lib/tools/registry";
import type { CustomerDirectory, ToolDeps } from "@/lib/tools/stores";
import type { ToolContext, ToolError } from "@/lib/tools/types";

const NOW = new Date("2026-11-23T12:00:00Z");

function deps(change: (r: NonNullable<ReturnType<CustomerDirectory["get"]>>) => void): ToolDeps {
  const base = customerDirectory(NOW);
  const customers: CustomerDirectory = {
    findByEmail: base.findByEmail,
    get: (id) => {
      const r = base.get(id);
      if (!r) return r;
      const copy = structuredClone(r);
      change(copy);
      return copy;
    },
  };
  return { customers, ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation", reason: "x", confidence: 0 }) }, now: () => NOW };
}
// Verified earlier as an active Pro customer (the snapshot the session log holds).
const ctx: ToolContext = { sessionId: "s", turnId: "t", customer: { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" }, failedVerifications: 0 };
const refund = (d: ToolDeps, amount: number) => executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2002", amount_usd: amount, reason: "x" }), ctx, d);
const code = (r: Awaited<ReturnType<typeof refund>>) => (r.result.ok ? "OK" : (r.result as { error: ToolError }).error.code);

describe("refund authorization uses the current account record", () => {
  it("contract expired after verification → refused as not active", async () => {
    expect(code(await refund(deps((r) => void (r.contractStatus = "expired")), 20))).toBe("CONTRACT_NOT_ACTIVE");
  });
  it("downgraded to Free after verification → Free rules apply (7-day window; Pro's 30 days would allow this 22-day-old charge)", async () => {
    expect(code(await refund(deps((r) => void (r.tier = "free")), 100))).toBe("OUTSIDE_REFUND_WINDOW");
  });
  it("unchanged account → as before", async () => {
    expect(code(await refund(deps(() => {}), 100))).toBe("OK");
  });
});
