/**
 * Voice transcript bookkeeping: what the caller actually heard, and logging each answer once to the
 * shared session log (/api/voice/events).
 */
import type { ChatMessage } from "@/components/agentEvents";
import type { Post, ResponseState, Upsert, VoiceRuntime } from "@/components/voice/types";

/** About 15 characters per second of speech: used to cut the transcript to what was heard. */
const CHARS_PER_SECOND = 15;

export function heardPortion(text: string, heardMs: number): string {
  const n = Math.round((heardMs / 1000) * CHARS_PER_SECOND);
  if (n >= text.length) return text;
  const cut = text.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Factory for an empty voice message, used when an upsert creates the message. */
export const voiceMsg =
  (id: string, role: "user" | "assistant"): (() => ChatMessage) =>
  () => ({ id, role, text: "", steps: [], channel: "voice" });

/** Logs what the caller actually heard, once: when playback ends, or after an interruption. */
export function logAssistant(resp: ResponseState, deps: { post: Post; sessionId: string | null; upsert: Upsert }): void {
  if (resp.logged) return;
  const spoken = (resp.interrupted ? resp.heardText : resp.text)?.trim();
  if (!spoken) return;
  resp.logged = true;
  void deps
    .post<{ flags: string[] }>("/api/voice/events", {
      sessionId: deps.sessionId,
      turnId: resp.turnId,
      event: { kind: "assistant_transcript", text: spoken, interrupted: resp.interrupted, at: resp.createdAt },
    })
    .then((res) => {
      if (res?.flags.length) deps.upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, flags: res.flags }));
    });
}

/**
 * Before the connection goes away (end, cap, drop): log every answer not yet logged. The one
 * still playing is cut to the portion heard so far and marked interrupted.
 */
export function flushTranscripts(c: VoiceRuntime, upsert: Upsert, log: (resp: ResponseState) => void): void {
  for (const resp of c.responses.values()) {
    if (resp.logged || !resp.text.trim()) continue;
    if (c.speaking && resp.id === c.playingResponseId && !resp.interrupted) {
      resp.interrupted = true;
      resp.heardText = heardPortion(resp.text, performance.now() - (resp.audioStart ?? performance.now()));
      upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.heardText ?? m.text, interrupted: true }));
    }
    log(resp);
  }
}
