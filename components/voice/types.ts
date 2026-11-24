/** Types and per-connection runtime state shared by the voice modules. */
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "@/components/agentEvents";

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

/** One model response: its transcript, playback timing and pending tool calls. */
export interface ResponseState {
  id: string;
  msgId: string;
  turnId: string;
  text: string;
  itemId?: string;
  audioStart?: number;
  /** Caller stopped speaking → agent audio started. */
  latencyMs?: number;
  firstDeltaAt?: number;
  interrupted: boolean;
  heardText?: string;
  truncateConfirmed: boolean;
  logged: boolean;
  calls: Promise<{ callId: string; output: string }>[];
}

export type Upsert = (id: string, make: () => ChatMessage, fn: (m: ChatMessage) => ChatMessage) => void;
export type Note = (dir: DebugEntry["dir"], type: string, detail?: string) => void;
export type Send = (obj: Record<string, unknown>) => void;
export type Post = <T>(url: string, body: unknown) => Promise<T | null>;
export type SetInterruptions = Dispatch<SetStateAction<InterruptionStat[]>>;

/** Mutable state of the current voice connection (kept in a ref; never triggers a render). */
export interface VoiceRuntime {
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  ctx: AudioContext | null;
  audioEl: HTMLAudioElement | null;
  micStream: MediaStream | null;
  clipDest: MediaStreamAudioDestinationNode | null;
  micAnalyser: AnalyserNode | null;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
  stopping: boolean;
  turnId: string;
  itemTurn: Map<string, string>;
  responses: Map<string, ResponseState>;
  activeResponseId: string | null;
  /** Response whose audio is playing now. Playback outlasts response.done by seconds. */
  playingResponseId: string | null;
  speaking: boolean;
  handledCalls: Set<string>;
  lastClipAt: number | null;
  lastSpeechStoppedAt: number | null;
  autoReconnects: number;
  autoReconnectPending: boolean;
  autoReconnectTimer: ReturnType<typeof setTimeout> | null;
  model: string;
}

export function createRuntime(): VoiceRuntime {
  return {
    pc: null,
    dc: null,
    ctx: null,
    audioEl: null,
    micStream: null,
    clipDest: null,
    micAnalyser: null,
    timer: null,
    startedAt: 0,
    stopping: false,
    turnId: "",
    itemTurn: new Map(),
    responses: new Map(),
    activeResponseId: null,
    playingResponseId: null,
    speaking: false,
    handledCalls: new Set(),
    lastClipAt: null,
    lastSpeechStoppedAt: null,
    autoReconnects: 0,
    autoReconnectPending: false,
    autoReconnectTimer: null,
    model: "",
  };
}
