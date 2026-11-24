/**
 * Retries for transient model errors (429, timeouts, 5xx): exponential backoff with jitter,
 * honouring Retry-After. Never retries once part of the reply has been streamed (that would
 * duplicate text), and never wraps tool execution (writes are idempotent by key instead).
 */
import { ModelError } from "@/lib/agent/model";

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; code: ModelError["code"] }) => void;
  /** Returns true once output has reached the user; retrying would then duplicate it. */
  committed?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_RETRY: Pick<RetryOptions, "attempts" | "baseMs" | "maxMs"> = { attempts: 3, baseMs: 400, maxMs: 4000 };

export function backoffMs(attempt: number, o: Pick<RetryOptions, "baseMs" | "maxMs">, retryAfterMs: number | undefined, random: () => number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, o.maxMs * 2);
  const exp = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5)); // "equal jitter"
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const transient = err instanceof ModelError && err.transient;
      if (!transient || attempt >= o.attempts || o.committed?.()) throw err;
      const delayMs = backoffMs(attempt, o, (err as ModelError).retryAfterMs, random);
      o.onRetry?.({ attempt: attempt + 1, attempts: o.attempts, delayMs, code: (err as ModelError).code });
      await sleep(delayMs);
    }
  }
}
