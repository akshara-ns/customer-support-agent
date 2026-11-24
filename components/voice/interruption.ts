/** Barge-in: stop playback at once, cut the transcript to what was heard, truncate the model's history. */
import { heardPortion, voiceMsg } from "@/components/voice/transcript";
import type { InterruptionStat, Note, ResponseState, Send, SetInterruptions, Upsert, VoiceRuntime } from "@/components/voice/types";

/** How long to wait for the server's own truncation before truncating from the client. */
const SERVER_TRUNCATE_WAIT_MS = 700;

export function interruptPlayback(
  c: VoiceRuntime,
  deps: { send: Send; upsert: Upsert; note: Note; logAssistant: (resp: ResponseState) => void; setInterruptions: SetInterruptions },
): void {
  const { send, upsert, note, logAssistant, setInterruptions } = deps;
  const id = c.speaking ? (c.playingResponseId ?? c.activeResponseId) : c.activeResponseId;
  const resp = id ? c.responses.get(id) : undefined;
  if (!resp || resp.interrupted || (!c.speaking && !resp.text)) return;
  const t0 = performance.now();
  if (c.audioEl) c.audioEl.muted = true; // stop what the caller hears immediately
  const muteMs = Math.round(performance.now() - t0);
  send({ type: "output_audio_buffer.clear" }); // drop audio still queued server-side (WebRTC)
  resp.interrupted = true;
  const start = resp.audioStart ?? resp.firstDeltaAt ?? performance.now();
  const heardMs = Math.max(0, Math.round(performance.now() - start));
  resp.heardText = heardPortion(resp.text, heardMs);
  upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.heardText ?? "", interrupted: true, streaming: false }));
  const stat: InterruptionStat = {
    at: Date.now(),
    muteMs,
    fromSpeechOnsetMs: c.lastClipAt !== null ? Math.round(performance.now() - c.lastClipAt) : null,
    heardMs,
    truncation: "pending",
  };
  setInterruptions((s) => [...s, stat]);
  note("note", "interrupted", `heard≈${heardMs}ms`);
  // The server truncates on barge-in when it can; if it hasn't confirmed shortly, truncate ourselves
  // so the conversation history matches what was actually heard.
  setTimeout(() => {
    if (!resp.truncateConfirmed && resp.itemId) {
      send({ type: "conversation.item.truncate", item_id: resp.itemId, content_index: 0, audio_end_ms: heardMs });
      setInterruptions((s) => s.map((x) => (x === stat ? { ...x, truncation: "client" } : x)));
    }
    logAssistant(resp);
  }, SERVER_TRUNCATE_WAIT_MS);
}

/** The server confirmed a truncation: record exactly how much was heard. */
export function applyServerTruncation(
  c: VoiceRuntime,
  itemId: unknown,
  audioEndMs: number,
  deps: { upsert: Upsert; setInterruptions: SetInterruptions },
): void {
  const resp = [...c.responses.values()].find((x) => x.itemId === itemId);
  if (!resp) return;
  resp.truncateConfirmed = true;
  resp.interrupted = true;
  resp.heardText = heardPortion(resp.text, audioEndMs);
  deps.upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.heardText ?? m.text, interrupted: true }));
  deps.setInterruptions((s) =>
    s.length ? [...s.slice(0, -1), { ...s[s.length - 1], heardMs: audioEndMs, truncation: "server" }] : s,
  );
}
