/** Clopper–Pearson intervals against published values. */
import { describe, expect, it } from "vitest";
import { clopperPearson, rate } from "@/evals/stats";

describe("Clopper–Pearson", () => {
  it("matches reference values", () => {
    const close = ([a, b]: [number, number], [c, d]: [number, number]) => {
      expect(a).toBeCloseTo(c, 3);
      expect(b).toBeCloseTo(d, 3);
    };
    close(clopperPearson(0, 15), [0, 0.2180]); // 1 − 0.025^(1/15)
    close(clopperPearson(15, 15), [0.7820, 1]);
    close(clopperPearson(1, 15), [0.00169, 0.3195]);
    close(clopperPearson(5, 10), [0.1871, 0.8129]);
  });
  it("formats a rate", () => {
    expect(rate(18, 18)).toBe("18/18 (100%, 95% CI 81%–100%)");
  });
});
