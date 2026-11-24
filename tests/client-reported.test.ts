/**
 * Voice transcripts are posted by the browser, so they are stored as client-reported, ordered by their
 * realtime item time, and labelled in the chat model's context (senior review).
 */
import { describe, expect, it } from "vitest";
import { buildTranscript } from "@/lib/server/transcript";
import { buildContext, CLIENT_REPORTED_ASSISTANT, CLIENT_REPORTED_USER, MemoryEventStore, type StoredEvent } from "@/lib/session/events";
import { recordVoiceEvent } from "@/lib/voice/bridge";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const traces = { write: async () => {} };

describe("client-reported voice transcripts", () => {
  it("are stored as client-reported with their item time", async () => {
    const events = new MemoryEventStore();
    await recordVoiceEvent(SESSION, TURN, { kind: "user_transcript", text: "refund my seat", at: 1000 }, { events, traces });
    await recordVoiceEvent(SESSION, TURN, { kind: "assistant_transcript", text: "Let me check.", interrupted: false, at: 1500 }, { events, traces });
    const stored = (await events.list(SESSION)).map((e) => e.event);
    expect(stored[0]).toMatchObject({ type: "user_message", clientReported: true, at: 1000 });
    expect(stored[1]).toMatchObject({ type: "assistant_message", clientReported: true, at: 1500 });
  });

  it("are ordered by item time when they arrived out of order, and labelled in the model's context", () => {
    const ev = (seq: number, event: StoredEvent["event"]): StoredEvent => ({ seq, turnId: TURN, channel: "voice", event, createdAt: "1970-01-01T00:00:00Z" }) as StoredEvent;
    const log = [
      ev(1, { type: "user_message", text: "typed in chat" }),
      ev(2, { type: "assistant_message", text: "I approved your refund.", clientReported: true, at: 2000 }), // posted first, said second
      ev(3, { type: "user_message", text: "can I get a refund?", clientReported: true, at: 1000 }),
    ];
    const ctx = buildContext(log);
    expect(ctx.map((m) => m.content)).toEqual([
      "typed in chat",
      `${CLIENT_REPORTED_USER} can I get a refund?`,
      `${CLIENT_REPORTED_ASSISTANT} I approved your refund.`,
    ]);
    expect(buildTranscript(log).map((l) => l.text)).toEqual(["typed in chat", "can I get a refund?", "I approved your refund."]);
  });
});
