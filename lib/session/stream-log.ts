import "server-only";
import { db } from "@/lib/db/client";
import type { SseEvent } from "@/lib/types";

/**
 * Write-behind buffer of a chat stream's numbered events. Events are batched (one HTTP round trip
 * per flush) and written in order; `close()` flushes the rest. Read back by the resume endpoint.
 */
export class StreamLog {
  private buffer: SseEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly streamId: string,
    private readonly sessionId: string,
  ) {}

  push(e: SseEvent): void {
    this.buffer.push(e);
    // Steps and errors matter most to a reconnecting client: flush them right away; batch the rest.
    if (e.type === "done" || e.type === "step_completed" || e.type === "error") this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 150);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.buffer;
    this.buffer = [];
    if (!batch.length) return;
    this.chain = this.chain.then(async () => {
      try {
        await db().transaction((tx) =>
          batch.map(
            (e) => tx`
              INSERT INTO stream_events (stream_id, seq, session_id, type, event)
              VALUES (${this.streamId}, ${e.seq}, ${this.sessionId}, ${e.type}, ${JSON.stringify(e)}::jsonb)
              ON CONFLICT DO NOTHING`,
          ),
        );
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "stream log write failed", streamId: this.streamId, error: String(err) }));
      }
    });
  }

  async close(): Promise<void> {
    this.flush();
    await this.chain;
  }
}

export async function readStreamEvents(streamId: string, after: number): Promise<SseEvent[]> {
  const rows = (await db()`
    SELECT event FROM stream_events WHERE stream_id = ${streamId} AND seq > ${after} ORDER BY seq`) as { event: SseEvent }[];
  return rows.map((r) => r.event);
}
