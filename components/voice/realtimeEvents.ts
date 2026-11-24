/**
 * Handles server events from the Realtime data channel: caller and agent transcripts, playback start
 * and stop, barge-in, tool calls, and usage. State lives in the runtime; UI changes go through upsert.
 */
import { applyServerTruncation } from "@/components/voice/interruption";
import type { ToolCall } from "@/components/voice/toolBridge";
import { voiceMsg } from "@/components/voice/transcript";
import type { Note, Post, ResponseState, Send, SetInterruptions, Upsert, VoiceActivity, VoiceRuntime } from "@/components/voice/types";

export interface EventDeps {
  note: Note;
  upsert: Upsert;
  post: Post;
  send: Send;
  sessionId: string | null;
  interrupt: () => void;
  startCall: (call: ToolCall) => void;
  logAssistant: (resp: ResponseState) => void;
  setInterruptions: SetInterruptions;
  setCostUsd: (fn: (x: number) => number) => void;
  setError: (msg: string) => void;
  /** Drives the listening / thinking / speaking indicator. */
  setActivity?: (a: VoiceActivity) => void;
}

const uuid = () => crypto.randomUUID();

/** Asks the model to continue, but only when no response is active; otherwise queues it for response.done. */
export function requestResponse(c: VoiceRuntime, send: Send): void {
  if (c.activeResponseId !== null) {
    c.pendingResponseCreate = true;
    return;
  }
  c.pendingResponseCreate = false;
  send({ type: "response.create" });
}

/**
 * The indicator, derived from state rather than from single events: playback is one continuous
 * buffer across a tool call, and its `stopped` event may name an earlier response.
 */
export function activityOf(c: VoiceRuntime): VoiceActivity {
  if (c.speaking) return "speaking";
  const toolsPending = [...c.responses.values()].some((r) => r.calls.length > 0 && !r.toolsReturned && !r.interrupted);
  return c.activeResponseId !== null || toolsPending ? "thinking" : "listening";
}

export async function handleServerEvent(c: VoiceRuntime, raw: string, d: EventDeps): Promise<void> {
  const { note, upsert, post, send, sessionId } = d;
  const update = () => d.setActivity?.(activityOf(c));
  let ev: Record<string, unknown> & { type: string };
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }
  if (!ev.type.endsWith(".delta")) {
    note("in", ev.type, ev.type === "error" ? JSON.stringify(ev.error) : undefined);
  }
  switch (ev.type) {
    case "input_audio_buffer.speech_started": {
      c.turnId = uuid();
      const itemId = String(ev.item_id ?? uuid());
      c.itemTurn.set(itemId, c.turnId);
      upsert(`vu-${itemId}`, voiceMsg(`vu-${itemId}`, "user"), (m) => ({ ...m, text: "…", streaming: true }));
      d.interrupt();
      d.setActivity?.("listening");
      break;
    }
    case "conversation.item.input_audio_transcription.delta": {
      const id = `vu-${ev.item_id}`;
      upsert(id, voiceMsg(id, "user"), (m) => ({ ...m, text: (m.text === "…" ? "" : m.text) + String(ev.delta ?? "") }));
      break;
    }
    case "conversation.item.input_audio_transcription.completed": {
      const itemId = String(ev.item_id);
      const text = String(ev.transcript ?? "").trim();
      const id = `vu-${itemId}`;
      upsert(id, voiceMsg(id, "user"), (m) => ({ ...m, text: text || "(inaudible)", streaming: false }));
      if (text) void post("/api/voice/events", { sessionId, turnId: c.itemTurn.get(itemId) ?? c.turnId, event: { kind: "user_transcript", text } });
      break;
    }
    case "response.created": {
      const resp = ev.response as { id: string };
      c.responses.set(resp.id, {
        id: resp.id,
        msgId: `va-${resp.id}`,
        turnId: c.turnId,
        text: "",
        interrupted: false,
        truncateConfirmed: false,
        logged: false,
        calls: [],
      });
      c.activeResponseId = resp.id;
      if (c.audioEl) c.audioEl.muted = false;
      update();
      break;
    }
    case "response.output_audio_transcript.delta": {
      const resp = c.responses.get(String(ev.response_id));
      if (!resp || resp.interrupted) break;
      resp.itemId = String(ev.item_id ?? resp.itemId ?? "");
      resp.firstDeltaAt ??= performance.now();
      resp.text += String(ev.delta ?? "");
      upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.text, streaming: true }));
      break;
    }
    case "input_audio_buffer.speech_stopped":
      c.lastSpeechStoppedAt = performance.now();
      d.setActivity?.("thinking");
      break;
    case "output_audio_buffer.started": {
      c.speaking = true;
      update();
      const rid = String(ev.response_id ?? c.activeResponseId);
      c.playingResponseId = rid;
      const resp = c.responses.get(rid);
      if (resp) {
        resp.audioStart ??= performance.now();
        if (resp.latencyMs === undefined && c.lastSpeechStoppedAt !== null) {
          resp.latencyMs = Math.round(resp.audioStart - c.lastSpeechStoppedAt);
          c.lastSpeechStoppedAt = null;
        }
      }
      break;
    }
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared": {
      c.speaking = false;
      const resp = c.responses.get(String(ev.response_id ?? c.playingResponseId));
      c.playingResponseId = null;
      update();
      if (resp && !resp.interrupted) d.logAssistant(resp); // full answer was heard
      break;
    }
    case "conversation.item.truncated":
      applyServerTruncation(c, ev.item_id, Number(ev.audio_end_ms ?? 0), { upsert, setInterruptions: d.setInterruptions });
      break;
    case "response.function_call_arguments.done":
      d.startCall({ callId: String(ev.call_id), name: String(ev.name), args: String(ev.arguments ?? "{}"), responseId: String(ev.response_id) });
      break;
    case "response.done": {
      const response = ev.response as {
        id: string;
        status?: string;
        output?: { type: string; call_id?: string; name?: string; arguments?: string }[];
        usage?: Record<string, unknown>;
      };
      const cancelled = response.status === "cancelled";
      const resp = c.responses.get(response.id);
      if (cancelled && resp) resp.interrupted = true; // its calls get a cancelled output, never run
      for (const item of response.output ?? []) {
        if (item.type === "function_call" && item.call_id && item.name) {
          d.startCall({ callId: item.call_id, name: item.name, args: item.arguments ?? "{}", responseId: response.id });
        }
      }
      if (c.activeResponseId === response.id) c.activeResponseId = null;
      // A response.create queued while this one was active can go now.
      if (c.pendingResponseCreate && !resp?.calls.length) requestResponse(c, send);
      if (response.usage) {
        void post<{ costUsd?: number }>("/api/voice/events", {
          sessionId,
          turnId: resp?.turnId ?? c.turnId,
          event: { kind: "usage", model: c.model, usage: response.usage, responseId: response.id, latencyMs: resp?.latencyMs },
        }).then((res) => res?.costUsd && d.setCostUsd((x) => x + (res.costUsd ?? 0)));
      }
      if (resp) {
        upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, streaming: false }));
        // Audio responses are logged when playback stops (or on interruption); text-only ones now.
        if (resp.audioStart === undefined) d.logAssistant(resp);
        update();
        // Return every tool result for this response, then ask the model to continue.
        if (resp.calls.length) {
          const outputs = await Promise.all(resp.calls);
          resp.toolsReturned = true;
          if (c.stopping || !c.dc) break;
          for (const o of outputs) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.callId, output: o.output } });
          // After an interruption the caller's new turn drives the next response; otherwise continue.
          if (!resp.interrupted) requestResponse(c, send);
          else if (c.pendingResponseCreate) requestResponse(c, send);
          update();
        }
      }
      break;
    }
    case "error": {
      const err = ev.error as { code?: string; message?: string } | undefined;
      // Only one response may be active: retry the create when the active one finishes.
      if (err?.code === "conversation_already_has_active_response") {
        c.pendingResponseCreate = true;
        break;
      }
      // Benign races (e.g. cancelling a response that already finished) are only logged.
      if (err?.code && /cancel|not_active|truncat/i.test(err.code)) break;
      d.setError(err?.message ?? "Voice error");
      break;
    }
  }
}
