/** Step rows show customer-facing text, never the tool's instructions to the agent. */
import { describe, expect, it } from "vitest";
import { summarizeOutcome } from "@/lib/tools/step";
import type { ToolOutcome } from "@/lib/tools/types";

const refused = (code: string, message: string): ToolOutcome =>
  ({ name: "issue_refund", result: { ok: false, error: { code, message, retryable: false } }, effects: {} }) as unknown as ToolOutcome;
const agentWording = /\b(ask|call|confirm the invoice|verify_identity|email null)\b/i;

describe("step text for refused tool calls", () => {
  it("INVOICE_AMBIGUOUS / MISMATCH / NOT_REQUESTED show customer text", () => {
    const ambiguous = summarizeOutcome(refused("INVOICE_AMBIGUOUS", "The customer hasn't said which invoice, and 6 are eligible. Ask which one (invoice id, amount or what the charge was for); nothing was refunded."));
    expect(ambiguous).toBe("Which invoice? Several are eligible; nothing was refunded");
    for (const [code, msg] of [
      ["INVOICE_MISMATCH", "Invoice inv_2002 doesn't match the customer's request (they asked about inv_2001). Confirm the invoice with them; nothing was refunded."],
      ["REFUND_NOT_REQUESTED", "The customer hasn't asked for a refund in this conversation. Ask what they need instead."],
    ]) expect(summarizeOutcome(refused(code, msg))).not.toMatch(agentWording);
  });

  it("a failed verification keeps the attempt count but drops the agent instructions", () => {
    const o = { name: "verify_identity", result: { ok: false, error: { code: "VERIFICATION_FAILED", message: "The email and support PIN don't match our records (attempt 1 of 3). The email is kept for this conversation: ask only for the PIN again, then call verify_identity with email null and the new code.", retryable: true } }, effects: {} } as unknown as ToolOutcome;
    expect(summarizeOutcome(o)).toBe("Email and PIN didn't match (attempt 1 of 3)");
  });

  it("policy refusals pass through unchanged (already customer-facing)", () => {
    expect(summarizeOutcome(refused("OVER_TIER_LIMIT", "$900 is above the $200 per-request limit for the pro tier; larger refunds go to the billing team."))).toContain("$900 is above the $200");
  });
});
