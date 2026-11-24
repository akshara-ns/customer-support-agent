/**
 * Collects timed spans for one turn (retrieval, guardrail checks, LLM calls) with token
 * usage and estimated cost. The chat SSE stream and the observability drawer consume these.
 */
import { PRICING_PER_MTOK } from "@/lib/config";
import type { SpanKind, TraceSpan } from "@/lib/types";

export interface Usage {
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export function estimateCostUsd(u: Usage): number {
  const price = PRICING_PER_MTOK[u.model];
  if (!price) return 0;
  return (u.tokensIn * price.input + u.tokensOut * price.output) / 1_000_000;
}

export interface SpanHandle {
  output(value: unknown): void;
  usage(u: Usage): void;
}

export class Trace {
  readonly turnId: string;
  readonly spans: TraceSpan[] = [];
  private readonly t0 = performance.now();

  constructor(turnId: string = crypto.randomUUID()) {
    this.turnId = turnId;
  }

  async span<T>(kind: SpanKind, name: string, input: unknown, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
    const startedAt = new Date();
    const t0 = performance.now();
    const span: TraceSpan = {
      id: crypto.randomUUID(),
      turnId: this.turnId,
      kind,
      name,
      status: "ok",
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      input,
    };
    const handle: SpanHandle = {
      output: (value) => {
        span.output = value;
      },
      usage: (u) => {
        span.tokensIn = (span.tokensIn ?? 0) + u.tokensIn;
        span.tokensOut = (span.tokensOut ?? 0) + u.tokensOut;
        span.costUsd = (span.costUsd ?? 0) + estimateCostUsd(u);
      },
    };
    try {
      return await fn(handle);
    } catch (err) {
      span.status = "error";
      span.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      span.durationMs = Math.round(performance.now() - t0);
      this.spans.push(span);
    }
  }

  /** Records an instantaneous span (state transitions, claim-check notes). */
  mark(kind: SpanKind, name: string, output?: unknown): void {
    this.spans.push({
      id: crypto.randomUUID(),
      turnId: this.turnId,
      kind,
      name,
      status: "ok",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      output,
    });
  }

  /** Wall-clock duration since the trace started (spans nest, so they are not summed); tokens and cost are summed. */
  totals(): { durationMs: number; tokensIn: number; tokensOut: number; costUsd: number } {
    return this.spans.reduce(
      (acc, s) => ({
        durationMs: acc.durationMs,
        tokensIn: acc.tokensIn + (s.tokensIn ?? 0),
        tokensOut: acc.tokensOut + (s.tokensOut ?? 0),
        costUsd: acc.costUsd + (s.costUsd ?? 0),
      }),
      { durationMs: Math.round(performance.now() - this.t0), tokensIn: 0, tokensOut: 0, costUsd: 0 },
    );
  }
}
