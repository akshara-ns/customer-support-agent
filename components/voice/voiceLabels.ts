/**
 * Display text for voice mode (header button and voice bar). Labels only, no connection behaviour.
 * Unit-tested in tests/voice-labels.test.ts.
 */
import type { VoiceActivity, VoiceState } from "@/components/voice/types";

/** Status pill in the voice bar. While live, the pill shows what the call is doing right now. */
const STATE_LABELS: Record<Exclude<VoiceState, "live">, string> = {
  idle: "Ready: press Start voice",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  ended: "Ended",
  error: "Error",
};

const ACTIVITY_LABELS: Record<VoiceActivity, string> = {
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
};

export function voiceStatusLabel(state: VoiceState, activity: VoiceActivity): string {
  return state === "live" ? ACTIVITY_LABELS[activity] : STATE_LABELS[state];
}

/** Header button: "Voice" opens the panel; once open (with or without a call) it closes it. */
export const voiceButtonLabel = (panelOpen: boolean) => (panelOpen ? "Close voice" : "Voice");

/** Call timer, e.g. "1:05 / 3:00". */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
export const voiceTimer = (elapsed: number, max: number) => `${mmss(elapsed)} / ${mmss(max)}`;
