"use client";

/**
 * Live voice over the OpenAI Realtime API (WebRTC). The browser holds only a short-lived
 * ephemeral key. Function calls are forwarded to /api/voice/tool (same executor as chat);
 * transcripts and usage go to /api/voice/events (same session log as chat).
 *
 * This hook owns React state and the connection lifecycle (start, stop, cap, drop, auto-reconnect).
 * The pieces it wires together:
 *   transport.ts       session key, SDP exchange, history replay, teardown
 *   audio.ts           mic / test-clip input, waveform analysers, clip playback
 *   realtimeEvents.ts  server events → transcript, playback and tool-call state
 *   toolBridge.ts      function calls → /api/voice/tool → step indicators
 *   interruption.ts    barge-in: mute, cut transcript to what was heard, truncate history
 *   transcript.ts      heard-portion estimate and logging each answer once
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { agentAnalyser, createCallerAudio, playClipInto } from "@/components/voice/audio";
import { interruptPlayback } from "@/components/voice/interruption";
import { handleServerEvent } from "@/components/voice/realtimeEvents";
import { startToolCall, type ToolCall } from "@/components/voice/toolBridge";
import { flushTranscripts as flushAll, logAssistant as logOnce } from "@/components/voice/transcript";
import { fetchVoiceSession, negotiate, releaseConnection, replayHistory } from "@/components/voice/transport";
import {
  createRuntime,
  type DebugEntry,
  type InterruptionStat,
  type MicMode,
  type ResponseState,
  type Upsert,
  type VoiceState,
} from "@/components/voice/types";

export type { DebugEntry, InterruptionStat, MicMode, VoiceState } from "@/components/voice/types";

export function useVoice({
  sessionId,
  upsert,
  debug = false,
  takeFault,
}: {
  sessionId: string | null;
  upsert: Upsert;
  debug?: boolean;
  /** One-shot demo fault for the next voice tool call (from the trace drawer). */
  takeFault?: () => string | null;
}) {
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
  const [agentLevel, setAgentAnalyser] = useState<AnalyserNode | null>(null);

  const r = useRef(createRuntime());

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

  const teardown = useCallback(() => {
    releaseConnection(r.current);
    setMicAnalyser(null);
    setAgentAnalyser(null);
  }, []);

  const logAssistant = useCallback((resp: ResponseState) => logOnce(resp, { post, sessionId, upsert }), [post, sessionId, upsert]);

  const flushTranscripts = useCallback(() => flushAll(r.current, upsert, logAssistant), [logAssistant, upsert]);

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

  const interrupt = useCallback(
    () => interruptPlayback(r.current, { send, upsert, note, logAssistant, setInterruptions }),
    [send, upsert, note, logAssistant],
  );

  const startCall = useCallback(
    (call: ToolCall) => startToolCall(r.current, call, { post, sessionId, upsert, note, takeFault }),
    [post, sessionId, upsert, note, takeFault],
  );

  const onEvent = useCallback(
    (raw: string) =>
      handleServerEvent(r.current, raw, {
        note,
        upsert,
        post,
        send,
        sessionId,
        interrupt,
        startCall,
        logAssistant,
        setInterruptions,
        setCostUsd,
        setError,
      }),
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
      c.turnId = crypto.randomUUID();
      c.responses.clear();
      setMode(useMode);
      setError(null);
      setEndedReason(null);
      setElapsed(0);
      setState("connecting");
      note("note", `connecting (${useMode})`);
      try {
        const info = await fetchVoiceSession(sessionId);
        c.model = info.model;
        setMaxSeconds(info.maxSeconds);

        const ctx = new AudioContext();
        c.ctx = ctx;
        const caller = await createCallerAudio(ctx, useMode);
        c.micAnalyser = caller.analyser;
        c.micStream = caller.micStream;
        c.clipDest = caller.clipDest;
        setMicAnalyser(caller.analyser);

        const pc = new RTCPeerConnection();
        c.pc = pc;
        const audioEl = new Audio();
        audioEl.autoplay = true;
        c.audioEl = audioEl;
        pc.ontrack = (e) => {
          audioEl.srcObject = e.streams[0];
          setAgentAnalyser(agentAnalyser(ctx, e.streams[0]));
        };
        pc.addTrack(caller.track, caller.stream);
        const syncConn = () => setConn({ pc: pc.connectionState, ice: pc.iceConnectionState, dc: c.dc?.readyState ?? "closed" });
        pc.onconnectionstatechange = () => {
          syncConn();
          note("note", `pc ${pc.connectionState}`);
          if (c.stopping) return;
          if (pc.connectionState === "failed") flushTranscripts();
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") setState("reconnecting");
          // One automatic reconnect (new key, same session, history replayed); then the manual button.
          if (pc.connectionState === "failed" && c.autoReconnects < 1) c.autoReconnectPending = true;
          if (pc.connectionState === "connected") setState((s) => (s === "reconnecting" ? "live" : s));
        };
        pc.oniceconnectionstatechange = syncConn;

        const dc = pc.createDataChannel("oai-events");
        c.dc = dc;
        dc.onmessage = (m) => void onEvent(String(m.data));
        dc.onopen = () => {
          syncConn();
          replayHistory(send, info.history);
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
          if (c.stopping) return;
          setState("reconnecting");
          if (c.autoReconnects < 1) c.autoReconnectPending = true;
        };

        await negotiate(pc, info.clientSecret);
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

  // One automatic reconnect after a drop (new key, same session, history replayed); then the manual button.
  // Scheduled once; not cleared on re-render (callback identities change every render).
  useEffect(() => {
    const c = r.current;
    if (state !== "reconnecting" || !c.autoReconnectPending || c.autoReconnectTimer) return;
    c.autoReconnects++;
    note("note", "auto-reconnect");
    c.autoReconnectTimer = setTimeout(() => {
      c.autoReconnectTimer = null;
      c.autoReconnectPending = false;
      if (!c.stopping) void start(mode);
    }, 1000);
  }, [state, start, mode, note]);

  const restart = useCallback(() => {
    r.current.autoReconnects = 0;
    void start(mode);
  }, [start, mode]);

  /** Debug: drop the peer connection as a network failure would. */
  const simulateDrop = useCallback(() => {
    const c = r.current;
    flushTranscripts();
    try {
      c.pc?.close();
    } catch {}
    if (c.timer) clearInterval(c.timer);
    if (c.autoReconnects < 1) c.autoReconnectPending = true;
    setState("reconnecting");
    setConn((x) => ({ ...x, pc: "closed (simulated drop)", dc: "closed" }));
    note("note", "simulated network drop");
  }, [note, flushTranscripts]);

  /** Test-clip mode: plays a pre-recorded caller utterance into the outgoing audio track. */
  const playClip = useCallback(
    async (id: string) => {
      const c = r.current;
      if (!c.ctx || !c.clipDest || !c.micAnalyser) return;
      const duration = await playClipInto(c.ctx, c.clipDest, c.micAnalyser, id, () => {
        c.lastClipAt = performance.now();
      });
      note("note", `clip ${id} (${duration.toFixed(1)}s)`);
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
    agentAnalyser: agentLevel,
    start,
    stop,
    restart,
    simulateDrop,
    playClip,
  };
}
