/** 3-level confidence (the evidence round): LOW = escalated; HIGH = grounded, untrimmed, strong and unambiguous retrieval; else MEDIUM. */
import { describe, expect, it } from "vitest";
import { confidenceLevel, docMargin } from "@/lib/guardrails/confidence";
import type { RetrievedChunk } from "@/lib/types";

const c = (docId: string, score: number) => ({ chunkKey: `${docId}#0`, docId, score }) as RetrievedChunk;
const base = { escalated: false, partial: false, highTop1: 0.45, highDocMargin: 0.1 };

describe("confidence level", () => {
  it("doc margin compares documents, not chunks of the same document", () => {
    expect(docMargin([c("refund-policy", 0.62), c("refund-policy", 0.6), c("plans", 0.5)])).toBeCloseTo(0.12);
    expect(docMargin([c("refund-policy", 0.62)])).toBeCloseTo(0.62);
  });
  it("HIGH only with strong top-1, a clear best document and no trimming", () => {
    expect(confidenceLevel({ ...base, topScore: 0.6, docMargin: 0.15 })).toBe("high");
    expect(confidenceLevel({ ...base, topScore: 0.6, docMargin: 0.05 })).toBe("medium"); // two documents compete
    expect(confidenceLevel({ ...base, topScore: 0.4, docMargin: 0.2 })).toBe("medium"); // weak retrieval
    expect(confidenceLevel({ ...base, partial: true, topScore: 0.6, docMargin: 0.2 })).toBe("medium"); // partly grounded
    expect(confidenceLevel({ ...base, escalated: true, topScore: 0.9, docMargin: 0.5 })).toBe("low");
  });
});
