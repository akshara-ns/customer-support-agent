/**
 * Client side of the SSE stream protocol: frame parsing and resume de-duplication. Pure (no React),
 * so the protocol is unit-tested (tests/stream-resume.test.ts).
 */
import type { SseEvent } from "@/lib/types";

/** Parses `data: {...}` frames from an SSE byte stream; frames may be split across chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as SseEvent;
    }
  }
}

/**
 * Tracks the last event number seen across the original stream and any resumed streams.
 * `accept` returns false for an event already applied (a replay), so nothing is applied twice;
 * `last` is what the client sends as `after` when it reconnects.
 */
export function createSeqTracker() {
  let last = 0;
  return {
    accept(e: SseEvent): boolean {
      if (e.seq <= last) return false;
      last = e.seq;
      return true;
    },
    get last() {
      return last;
    },
  };
}
