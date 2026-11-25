/** The reviewer example prompts do what their labels say under the refund rules in code. */
import { describe, expect, it } from "vitest";
import { TRY_PROMPTS } from "@/components/tryPrompts";
import { customerDirectory } from "@/lib/tools/customers";
import { REFUND_INTENT, requestedInvoices } from "@/lib/tools/policy";

const omar = customerDirectory(new Date()).get("cus_pro_omar")!;
const text = (label: string) => TRY_PROMPTS.find((p) => p.label.startsWith(label))!.text;

describe("Try this prompts", () => {
  it("verify prompt carries the Pro demo user's email and PIN", () => {
    expect(text("Verify")).toContain(omar.email);
    expect(text("Verify")).toContain(omar.supportPin);
    expect(omar.tier).toBe("pro");
  });

  it("the within-limit refund names one eligible invoice under the Pro limit", () => {
    const t = text("Refund within");
    expect(REFUND_INTENT.test(t)).toBe(true);
    expect(requestedInvoices([t], omar.invoices)).toEqual(new Set(["inv_2004"]));
    const inv = omar.invoices.find((i) => i.invoiceId === "inv_2004")!;
    expect(inv.amountUsd).toBe(29); // ≤ $200, recent, not refunded in the seed data
    expect(inv.refundedUsd).toBe(0);
  });

  it("the over-limit refund asks for more than the Pro per-request limit on a named invoice", () => {
    const t = text("Over-limit");
    expect(REFUND_INTENT.test(t)).toBe(true);
    expect(requestedInvoices([t], omar.invoices)).toEqual(new Set(["inv_2003"]));
    expect(t).toContain("$900");
  });

  it("the policy and off-topic prompts don't ask for a refund", () => {
    expect(REFUND_INTENT.test(text("Off-topic"))).toBe(false);
  });
});
