/**
 * Connection to the OpenAI Realtime API over WebRTC: the ephemeral session from our server, the SDP
 * offer/answer, history replay on the data channel, and releasing everything on teardown.
 */
import type { Send, VoiceRuntime } from "@/components/voice/types";
import type { VoiceHistoryItem, VoiceSessionResponse } from "@/lib/contracts";

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** Asks our server for a short-lived Realtime key (the real API key never reaches the browser). */
export async function fetchVoiceSession(sessionId: string): Promise<VoiceSessionResponse> {
  const res = await fetch("/api/voice/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const info = (await res.json()) as VoiceSessionResponse & { message?: string };
  if (!res.ok) throw new Error(info.message ?? `Voice session failed (${res.status})`);
  return info;
}

/** SDP offer/answer with the Realtime API using the ephemeral key. */
export async function negotiate(pc: RTCPeerConnection, clientSecret: string): Promise<void> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdp = await fetch(REALTIME_CALLS_URL, {
    method: "POST",
    body: offer.sdp,
    headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
  });
  if (!sdp.ok) throw new Error(`Realtime connection failed (${sdp.status})`);
  await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
}

/** Shared session: replay recent chat/voice turns so the model has the conversation so far. */
export function replayHistory(send: Send, history: VoiceHistoryItem[]): void {
  for (const h of history) {
    send({
      type: "conversation.item.create",
      item: { type: "message", role: h.role, content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }] },
    });
  }
}

/** Closes the data channel, peer connection, mic and audio context, and clears the runtime. */
export function releaseConnection(c: VoiceRuntime): void {
  if (c.timer) clearInterval(c.timer);
  c.timer = null;
  try {
    c.dc?.close();
  } catch {}
  try {
    c.pc?.close();
  } catch {}
  c.micStream?.getTracks().forEach((t) => t.stop());
  if (c.audioEl) {
    c.audioEl.srcObject = null;
  }
  void c.ctx?.close().catch(() => {});
  Object.assign(c, {
    pc: null,
    dc: null,
    ctx: null,
    micStream: null,
    clipDest: null,
    micAnalyser: null,
    audioEl: null,
    activeResponseId: null,
    playingResponseId: null,
    speaking: false,
  });
}
