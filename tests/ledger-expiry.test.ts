/**
 * Stuck pending refunds (grader, review round 2): a failure after the write-ahead entry left the invoice
 * "in progress" forever. Pending entries now expire; the next request on the invoice resolves them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { runWithFault } from "@/lib/faults";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { PENDING_REFUND_EXPIRY_SEC } from "@/lib/tools/policy";
import { executeTool } from "@/lib/tools/registry";
import type { PolicySearch, ToolDeps } from "@/lib/tools/stores";
import type { ToolContext, ToolError, VerifiedCustomer } from "@/lib/tools/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const policy: PolicySearch = { search: async () => ({ status: "needs_escalation", reason: "low_retrieval_confidence", confidence: 0.1 }) };
const OMAR: VerifiedCustomer = { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" };

let clock: number;
let ledger: MemoryLedger;
let deps: ToolDeps;

beforeEach(() => {
  clock = NOW.getTime();
  ledger = new MemoryLedger(() => clock);
  deps = { customers: customerDirectory(NOW), ledger, tickets: new MemoryTickets(), policy, now: () => NOW };
});

const ctx = (sessionId: string): ToolContext => ({ sessionId, turnId: "t", customer: OMAR, failedVerifications: 0 });
const refund = (sessionId: string, amount = 29) =>
  executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2004", amount_usd: amount, reason: "test" }), ctx(sessionId), deps);
const code = (r: Awaited<ReturnType<typeof refund>>) => (r.result.ok ? "OK" : (r.result as { error: ToolError }).error.code);
const succeeded = () => [...ledger.entries.values()].filter((e) => e.status === "succeeded");
const crash = () => runWithFault("tool_failure", () => refund("s1"));

describe("pending refund expiry", () => {
  it("the public tool_failure switch can't lock an invoice: after expiry another request succeeds exactly once", async () => {
    expect(code(await crash())).toBe("TOOL_FAILURE");
    expect(code(await refund("s2"))).toBe("REFUND_IN_PROGRESS"); // still within the expiry window
    clock += (PENDING_REFUND_EXPIRY_SEC + 1) * 1000;
    expect(code(await refund("s2"))).toBe("OK");
    expect(code(await refund("s3"))).toBe("ALREADY_REFUNDED");
    expect(succeeded()).toHaveLength(1);
    const expired = [...ledger.entries.values()].filter((e) => e.status === "rejected");
    expect(expired).toHaveLength(1);
    expect(expired[0].result).toMatchObject({ code: "REQUEST_EXPIRED" });
  });

  it("the same idempotency key still resumes its own request, even after the expiry time", async () => {
    await crash();
    clock += (PENDING_REFUND_EXPIRY_SEC + 60) * 1000;
    const r = await refund("s1"); // same session, invoice and amount → same key
    expect(code(r)).toBe("OK");
    expect(succeeded()).toHaveLength(1);
  });

  it("after expiry, concurrent requests still produce only one refund", async () => {
    await crash();
    clock += (PENDING_REFUND_EXPIRY_SEC + 1) * 1000;
    const results = await Promise.all([refund("s2"), refund("s3", 20), refund("s4", 10)]);
    expect(results.filter((r) => r.result.ok)).toHaveLength(1);
    expect(succeeded()).toHaveLength(1);
  });

  it("a request that expired can start again later with the same key", async () => {
    await crash();
    clock += (PENDING_REFUND_EXPIRY_SEC + 1) * 1000;
    expect(code(await refund("s2", 900))).toBe("AMOUNT_EXCEEDS_INVOICE"); // expires s1's entry, then is rejected itself
    expect(code(await refund("s1"))).toBe("OK"); // s1's retry is a fresh request, not stuck on its expired entry
    expect(succeeded()).toHaveLength(1);
  });
});
