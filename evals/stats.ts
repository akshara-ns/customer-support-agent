/** Exact (Clopper–Pearson) binomial confidence intervals for the eval reports. Pure; unit-tested. */

function logChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X ≤ k) for X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, sum);
}

function bisect(f: (p: number) => number, target: number, increasing: boolean): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if ((v < target) === increasing) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Exact two-sided Clopper–Pearson interval for k successes in n trials. */
export function clopperPearson(k: number, n: number, confidence = 0.95): [number, number] {
  if (n === 0) return [0, 1];
  const a = (1 - confidence) / 2;
  // Lower: P(X ≥ k | p) = a  ⇔  1 − cdf(k−1) = a (increasing in p).
  const lower = k === 0 ? 0 : bisect((p) => 1 - binomCdf(k - 1, n, p), a, true);
  // Upper: P(X ≤ k | p) = a (decreasing in p).
  const upper = k === n ? 1 : bisect((p) => binomCdf(k, n, p), a, false);
  return [lower, upper];
}

/** "k/n (p%, 95% CI lo–hi%)" */
export function rate(k: number, n: number): string {
  if (n === 0) return "0/0 (n/a)";
  const [lo, hi] = clopperPearson(k, n);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return `${k}/${n} (${pct(k / n)}, 95% CI ${pct(lo)}–${pct(hi)})`;
}
