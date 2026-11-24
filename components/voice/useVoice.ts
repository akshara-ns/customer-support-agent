"use client";

/**
 * Live voice over the OpenAI Realtime API (WebRTC). The browser holds only a short-lived
 * ephemeral key. Function calls are forwarded to /api/voice/tool (same executor as chat);
 * transcripts and usage go to /api/voice/events (same session log as chat).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/components/useChat";
import { applyAgentEvent } from "@/components/useChat";
import { TOOL_LABELS } from "@/lib/tools/labels";
import type { AgentEvent } from "@/lib/types";

export type VoiceState = "idle" | "connecting" | "live" | "reconnecting" | "ended" | "error";
export type MicMode = "mic" | "clips";

export interface DebugEntry {
  t: number;
  dir: "in" | "out" | "note";
  type: string;
  detail?: string;
}

export interface InterruptionStat {
  at: number;
  /** speech_started → local playback muted (client reaction time). */
  muteMs: number;
  /** Test clips only: caller audio started → playback muted (includes server VAD detection). */
  fromSpeechOnsetMs: number | null;
  heardMs: number;
  truncation: "server" | "client" | "pending";
}

interface ResponseState {
  id: string;
  msgId: string;
  turnId: string;
  text: string;
  itemId?: string;
  audioStart?: number;
  firstDeltaAt?: number;
  interrupted: boolean;
  heardText?: string;
  truncateConfirmed: boolean;
  logged: boolean;
  calls: Promise<{ callId: string; output: string }>[];
}

type Upsert = (id: string, make: () => ChatMessage, fn: (m: ChatMessage) => ChatMessage) => void;

interface SessionInfo {
  clientSecret: string;
  model: string;
  verified: boolean;
  history: { role: "user" | "assistant"; text: string }[];
  maxSeconds: number;
}

/** About 15 characters per second of speech: used to cut the transcript to what was heard. */
const CHARS_PER_SECOND = 15;

function heardPortion(text: string, heardMs: number): string {
  const n = Math.round((heardMs / 1000) * CHARS_PER_SECOND);
  if (n >= text.length) return text;
  const cut = text.slice(0, n);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trim()}…`;
}

const uuid = () => crypto.randomUUID();

export function useVoice({ sessionId, upsert, debug = false }: { sessionId: string | null; upsert: Upsert; debug?: boolean }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [mode, setMode] = useState<MicMode>("mic");
  const [elapsed, setElapsed] = useState(0);
  const [maxSeconds, setMaxSeconds] = useState(180);
  const [error, setError] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [log, setLog] = useState<DebugEntry[]>([]);
  const [interruptions, setInterruptions] = useState<InterruptionStat[]>([]);
  const [costUsd, setCostUsd] = useState(0);
  const [conn, setConn] = useState({ pc: "new", ice: "new", dc: "closed" });
  const [micAnalyser, setMicAnalyser] = useState<AnalyserNode | null>(null);
  const [agentAnalyser, setAgentAnalyser] = useState<AnalyserNode | null>(null);

  const r = useRef({
    pc: null as RTCPeerConnection | null,
    dc: null as RTCDataChannel | null,
    ctx: null as AudioContext | null,
    audioEl: null as HTMLAudioElement | null,
    micStream: null as MediaStream | null,
    clipDest: null as MediaStreamAudioDestinationNode | null,
    micAnalyser: null as AnalyserNode | null,
    timer: null as ReturnType<typeof setInterval> | null,
    startedAt: 0,
    stopping: false,
    turnId: "",
    itemTurn: new Map<string, string>(),
    responses: new Map<string, ResponseState>(),
    activeResponseId: null as string | null,
    /** Response whose audio is playing now. Playback outlasts response.done by seconds. */
    playingResponseId: null as string | null,
    speaking: false,
    handledCalls: new Set<string>(),
    lastClipAt: null as number | null,
    model: "",
  });

  const note = useCallback(
    (dir: DebugEntry["dir"], type: string, detail?: string) => {
      if (!debug) return;
      setLog((l) => [...l.slice(-199), { t: Date.now(), dir, type, detail }]);
    },
    [debug],
  );

  const send = useCallback(
    (obj: Record<string, unknown>) => {
      const dc = r.current.dc;
      if (dc?.readyState !== "open") return;
      dc.send(JSON.stringify(obj));
      note("out", String(obj.type));
    },
    [note],
  );

  const post = useCallback(
    async <T,>(url: string, body: unknown): Promise<T | null> => {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) {
          note("note", `${url} → ${res.status}`);
          return null;
        }
        return (await res.json()) as T;
      } catch {
        note("note", `${url} failed`);
        return null;
      }
    },
    [note],
  );

  const voiceMsg = (id: string, role: "user" | "assistant"): (() => ChatMessage) => () => ({ id, role, text: "", steps: [], channel: "voice" });

  const teardown = useCallback(() => {
    const c = r.current;
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
    Object.assign(c, { pc: null, dc: null, ctx: null, micStream: null, clipDest: null, micAnalyser: null, audioEl: null, activeResponseId: null, playingResponseId: null, speaking: false });
    setMicAnalyser(null);
    setAgentAnalyser(null);
  }, []);

  /** Logs what the caller actually heard, once: when playback ends, or after an interruption. */
  const logAssistant = useCallback(
    (resp: ResponseState) => {
      if (resp.logged) return;
      const spoken = (resp.interrupted ? resp.heardText : resp.text)?.trim();
      if (!spoken) return;
      resp.logged = true;
      void post<{ flags: string[] }>("/api/voice/events", {
        sessionId,
        turnId: resp.turnId,
        event: { kind: "assistant_transcript", text: spoken, interrupted: resp.interrupted },
      }).then((res) => {
        if (res?.flags.length) upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, flags: res.flags }));
      });
    },
    [post, sessionId, upsert],
  );

  /**
   * Before the connection goes away (end, cap, drop): log every answer not yet logged. The one
   * still playing is cut to the portion heard so far and marked interrupted.
   */
  const flushTranscripts = useCallback(() => {
    const c = r.current;
    for (const resp of c.responses.values()) {
      if (resp.logged || !resp.text.trim()) continue;
      if (c.speaking && resp.id === c.playingResponseId && !resp.interrupted) {
        resp.interrupted = true;
        resp.heardText = heardPortion(resp.text, performance.now() - (resp.audioStart ?? performance.now()));
        upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.heardText ?? m.text, interrupted: true }));
      }
      logAssistant(resp);
    }
  }, [logAssistant, upsert]);

  const stop = useCallback(
    (reason = "You ended the voice session.") => {
      r.current.stopping = true;
      flushTranscripts();
      teardown();
      setEndedReason(reason);
      setState("ended");
      note("note", "ended", reason);
    },
    [teardown, note, flushTranscripts],
  );

  // ---- interruption ----
  const interrupt = useCallback(() => {
    const c = r.current;
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
    }, 700);
  }, [send, upsert, note, logAssistant]);

  // ---- tool bridge ----
  const startCall = useCallback(
    (callId: string, name: string, args: string, responseId: string) => {
      const c = r.current;
      if (c.handledCalls.has(callId)) return;
      c.handledCalls.add(callId);
      const resp = c.responses.get(responseId);
      // A call from an interrupted/cancelled response may have half-streamed arguments: drop it.
      if (resp?.interrupted) {
        note("note", `tool ${name} dropped (response interrupted)`);
        return;
      }
      const turnId = resp?.turnId ?? c.turnId;
      const msgId = resp?.msgId ?? `va-${responseId}`;
      const stepId = `${turnId}:${callId}`;
      upsert(msgId, voiceMsg(msgId, "assistant"), (m) =>
        applyAgentEvent(m, { type: "step_started", stepId, tool: name, label: TOOL_LABELS[name] ?? name }),
      );
      note("note", `tool → ${name}`);
      const p = post<{ output: string; events: AgentEvent[] }>("/api/voice/tool", { sessionId, turnId, callId, name, arguments: args }).then((res) => {
        for (const e of res?.events ?? []) upsert(msgId, voiceMsg(msgId, "assistant"), (m) => applyAgentEvent(m, e));
        const output =
          res?.output ??
          JSON.stringify({ ok: false, error: { code: "TOOL_FAILURE", message: "The system couldn't complete this step.", retryable: true } });
        note("note", `tool ← ${name}`, output.slice(0, 160));
        return { callId, output };
      });
      resp?.calls.push(p);
    },
    [post, sessionId, upsert, note],
  );

  // ---- server events ----
  const onEvent = useCallback(
    async (raw: string) => {
      const c = r.current;
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
          interrupt();
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
        case "output_audio_buffer.started": {
          c.speaking = true;
          const rid = String(ev.response_id ?? c.activeResponseId);
          c.playingResponseId = rid;
          const resp = c.responses.get(rid);
          if (resp) resp.audioStart ??= performance.now();
          break;
        }
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared": {
          c.speaking = false;
          const resp = c.responses.get(String(ev.response_id ?? c.playingResponseId));
          c.playingResponseId = null;
          if (resp && !resp.interrupted) logAssistant(resp); // full answer was heard
          break;
        }
        case "conversation.item.truncated": {
          const resp = [...c.responses.values()].find((x) => x.itemId === ev.item_id);
          if (resp) {
            resp.truncateConfirmed = true;
            resp.interrupted = true;
            const ms = Number(ev.audio_end_ms ?? 0);
            resp.heardText = heardPortion(resp.text, ms);
            upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, text: resp.heardText ?? m.text, interrupted: true }));
            setInterruptions((s) => (s.length ? [...s.slice(0, -1), { ...s[s.length - 1], heardMs: ms, truncation: "server" }] : s));
          }
          break;
        }
        case "response.function_call_arguments.done":
          startCall(String(ev.call_id), String(ev.name), String(ev.arguments ?? "{}"), String(ev.response_id));
          break;
        case "response.done": {
          const response = ev.response as {
            id: string;
            status?: string;
            output?: { type: string; call_id?: string; name?: string; arguments?: string }[];
            usage?: Record<string, unknown>;
          };
          const cancelled = response.status === "cancelled";
          for (const item of response.output ?? []) {
            if (!cancelled && item.type === "function_call" && item.call_id && item.name) {
              startCall(item.call_id, item.name, item.arguments ?? "{}", response.id);
            }
          }
          const resp = c.responses.get(response.id);
          if (c.activeResponseId === response.id) c.activeResponseId = null;
          if (response.usage) {
            void post<{ costUsd?: number }>("/api/voice/events", {
              sessionId,
              turnId: resp?.turnId ?? c.turnId,
              event: { kind: "usage", model: c.model, usage: response.usage, responseId: response.id },
            }).then((res) => res?.costUsd && setCostUsd((x) => x + (res.costUsd ?? 0)));
          }
          if (resp) {
            upsert(resp.msgId, voiceMsg(resp.msgId, "assistant"), (m) => ({ ...m, streaming: false }));
            // Audio responses are logged when playback stops (or on interruption); text-only ones now.
            if (resp.audioStart === undefined) logAssistant(resp);
            // Return every tool result for this response, then ask the model to continue.
            if (resp.calls.length) {
              const outputs = await Promise.all(resp.calls);
              if (c.stopping || !c.dc) break;
              for (const o of outputs) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: o.callId, output: o.output } });
              send({ type: "response.create" });
            }
          }
          break;
        }
        case "error": {
          const err = ev.error as { code?: string; message?: string } | undefined;
          // Benign races (e.g. cancelling a response that already finished) are only logged.
          if (err?.code && /cancel|not_active|truncat/i.test(err.code)) break;
          setError(err?.message ?? "Voice error");
          break;
        }
      }
    },
    [interrupt, note, post, send, sessionId, startCall, upsert, logAssistant],
  );

  // ---- connect ----
  const start = useCallback(
    async (useMode: MicMode = mode) => {
      if (!sessionId) return;
      const c = r.current;
      teardown();
      c.stopping = false;
      c.handledCalls.clear();
      c.turnId = uuid();
      c.responses.clear();
      setMode(useMode);
      setError(null);
      setEndedReason(null);
      setElapsed(0);
      setState("connecting");
      note("note", `connecting (${useMode})`);
      try {
        const res = await fetch("/api/voice/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const info = (await res.json()) as SessionInfo & { message?: string };
        if (!res.ok) throw new Error(info.message ?? `Voice session failed (${res.status})`);
        c.model = info.model;
        setMaxSeconds(info.maxSeconds);

        const ctx = new AudioContext();
        c.ctx = ctx;
        const mic = ctx.createAnalyser();
        mic.fftSize = 1024;
        c.micAnalyser = mic;
        let track: MediaStreamTrack;
        let stream: MediaStream;
        if (useMode === "mic") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          c.micStream = stream;
          ctx.createMediaStreamSource(stream).connect(mic);
          track = stream.getAudioTracks()[0];
        } else {
          const dest = ctx.createMediaStreamDestination();
          c.clipDest = dest;
          // A real mic always has a noise floor. Pure digital silence makes WebRTC stop sending packets
          // (DTX), so the server never hears the silence that ends a turn. Add -60 dB noise.
          const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
          const ch = noise.getChannelData(0);
          for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.001;
          const floor = ctx.createBufferSource();
          floor.buffer = noise;
          floor.loop = true;
          floor.connect(dest);
          floor.start();
          stream = dest.stream;
          track = stream.getAudioTracks()[0];
        }
        setMicAnalyser(mic);

        const pc = new RTCPeerConnection();
        c.pc = pc;
        const audioEl = new Audio();
        audioEl.autoplay = true;
        c.audioEl = audioEl;
        pc.ontrack = (e) => {
          audioEl.srcObject = e.streams[0];
          const agent = ctx.createAnalyser();
          agent.fftSize = 1024;
          ctx.createMediaStreamSource(e.streams[0]).connect(agent);
          setAgentAnalyser(agent);
        };
        pc.addTrack(track, stream);
        const syncConn = () => setConn({ pc: pc.connectionState, ice: pc.iceConnectionState, dc: c.dc?.readyState ?? "closed" });
        pc.onconnectionstatechange = () => {
          syncConn();
          note("note", `pc ${pc.connectionState}`);
          if (c.stopping) return;
          if (pc.connectionState === "failed") flushTranscripts();
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") setState("reconnecting");
          if (pc.connectionState === "connected") setState((s) => (s === "reconnecting" ? "live" : s));
        };
        pc.oniceconnectionstatechange = syncConn;

        const dc = pc.createDataChannel("oai-events");
        c.dc = dc;
        dc.onmessage = (m) => void onEvent(String(m.data));
        dc.onopen = () => {
          syncConn();
          // Shared session: replay recent chat/voice turns so the model has the conversation so far.
          for (const h of info.history) {
            send({
              type: "conversation.item.create",
              item: { type: "message", role: h.role, content: [{ type: h.role === "user" ? "input_text" : "output_text", text: h.text }] },
            });
          }
          c.startedAt = Date.now();
          c.timer = setInterval(() => {
            const s = Math.floor((Date.now() - c.startedAt) / 1000);
            setElapsed(s);
            if (s >= info.maxSeconds) stop(`The voice session reached its ${Math.round(info.maxSeconds / 60)}-minute limit.`);
          }, 250);
          setState("live");
          note("note", `live (history ${info.history.length}, verified ${info.verified})`);
        };
        dc.onclose = () => {
          syncConn();
          if (!c.stopping) setState("reconnecting");
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = await fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: `Bearer ${info.clientSecret}`, "Content-Type": "application/sdp" },
        });
        if (!sdp.ok) throw new Error(`Realtime connection failed (${sdp.status})`);
        await pc.setRemoteDescription({ type: "answer", sdp: await sdp.text() });
      } catch (err) {
        teardown();
        const msg = err instanceof Error ? err.message : "Couldn't start voice";
        setError(msg);
        setState("error");
        note("note", "error", msg);
      }
    },
    [mode, sessionId, teardown, note, onEvent, send, stop, flushTranscripts],
  );

  const restart = useCallback(() => void start(mode), [start, mode]);

  /** Debug: drop the peer connection as a network failure would. */
  const simulateDrop = useCallback(() => {
    const c = r.current;
    flushTranscripts();
    try {
      c.pc?.close();
    } catch {}
    if (c.timer) clearInterval(c.timer);
    setState("reconnecting");
    setConn((x) => ({ ...x, pc: "closed (simulated drop)", dc: "closed" }));
    note("note", "simulated network drop");
  }, [note, flushTranscripts]);

  /** Test-clip mode: plays a pre-recorded caller utterance into the outgoing audio track. */
  const playClip = useCallback(
    async (id: string) => {
      const c = r.current;
      if (!c.ctx || !c.clipDest || !c.micAnalyser) return;
      const buf = await (await fetch(`/voice-test/${id}.mp3`)).arrayBuffer();
      const audio = await c.ctx.decodeAudioData(buf);
      const src = c.ctx.createBufferSource();
      src.buffer = audio;
      src.connect(c.clipDest);
      src.connect(c.micAnalyser);
      c.lastClipAt = performance.now();
      src.start();
      note("note", `clip ${id} (${audio.duration.toFixed(1)}s)`);
    },
    [note],
  );

  useEffect(() => () => {
    r.current.stopping = true;
    teardown();
  }, [teardown]);

  return {
    state,
    mode,
    elapsed,
    maxSeconds,
    error,
    endedReason,
    log,
    interruptions,
    costUsd,
    conn,
    micAnalyser,
    agentAnalyser,
    start,
    stop,
    restart,
    simulateDrop,
    playClip,
  };
}
