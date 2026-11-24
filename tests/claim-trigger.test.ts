/** The model claim check runs only on text that could claim an action (review round 5, senior review). */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ACTION_CLAIM_TRIGGER, ClaimGate, type TurnActions } from "@/lib/guardrails/claims";

const NONE: TurnActions = { refunds: [], refundErrors: [], tickets: [] };
const set = JSON.parse(readFileSync("evals/action_claims_set.json", "utf8")) as { id: string; reply: string; false_claim: boolean }[];

describe("action-claim trigger", () => {
  it("matches every false claim in the labelled set (no recall lost)", () => {
    const missed = set.filter((x) => x.false_claim && !ACTION_CLAIM_TRIGGER.test(x.reply)).map((x) => x.id);
    expect(missed).toEqual([]);
  });

  it("skips text that mentions refunds without claiming anything", async () => {
    const checker = vi.fn(async () => ({ falseClaims: [] }));
    const gate = new ClaimGate(() => NONE, true);
    const out = [...gate.push("Refunds are handled by our billing policy. Which invoice is it about? "), ...(await gate.settle(checker))];
    expect(out.join("")).toBe("Refunds are handled by our billing policy. Which invoice is it about? ");
    expect(checker).not.toHaveBeenCalled();
  });

  it("on a checker timeout the regex-checked text is released and the error reported", async () => {
    const gate = new ClaimGate(() => NONE, true);
    gate.push("Your refund was processed. ");
    const onError = vi.fn();
    const out = await gate.settle(async () => Promise.reject(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })), onError);
    expect(out.join("")).toContain("No refund has been issued"); // the regex layer already corrected this one
    expect(onError).toHaveBeenCalled();
  });
});
