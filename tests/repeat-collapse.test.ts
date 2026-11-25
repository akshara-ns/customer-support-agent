/** The model sometimes outputs a sentence twice ("X\nX"); the final reply collapses immediate repeats. */
import { describe, expect, it } from "vitest";
import { collapseRepeatedSentences } from "@/lib/guardrails/final-rules";

describe("collapseRepeatedSentences", () => {
  it("collapses the repeat seen in the model's raw output", () => {
    const x = "Please send your email address on the account and your 6-digit support PIN, and I’ll check that for you.";
    expect(collapseRepeatedSentences(`${x}\n${x}`)).toBe(x);
  });
  it("keeps text without repeats exactly as is", () => {
    const t = "Refunds take 5 to 10 business days. Anything else?\nI can also open a ticket. ";
    expect(collapseRepeatedSentences(t)).toBe(t);
  });
  it("collapses only immediate repeats", () => {
    expect(collapseRepeatedSentences("A one. B two. A one.")).toBe("A one. B two. A one.");
    expect(collapseRepeatedSentences("A one. A one. B two.")).toBe("A one. B two.");
  });
});
