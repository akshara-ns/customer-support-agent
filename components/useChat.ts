"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEvent, ErrorCode, SseEvent, TicketSummary, TraceSpan } from "@/lib/types";

export interface Step {
  stepId: string;
  tool: string;
  label: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  summary?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  steps: Step[];
  escalation?: { kind: "ticket" | "suggested"; reason: string; ticket?: TicketSummary };
  error?: { code: ErrorCode; message: string; retryable: boolean; tool?: string };
  /** Shown while the client resumes a dropped stream from the last event it received. */
  reconnecting?: { attempt: number; after: number };
  /** The stream was resumed after this event number (no gaps, no duplicates). */
  resumedAfter?: number;
  /** Shown while the server retries a transient model error. */
  retrying?: { attempt: number; attempts: number; reason: ErrorCode };
  streaming?: boolean;
  totals?: { durationMs: number; tokensIn: number; tokensOut: number; costUsd: number; ttftMs?: number };
  spans?: TraceSpan[];
  channel?: "chat" | "voice";
  /** Voice: the caller interrupted; text shows only what was (approximately) heard. */
  interrupted?: boolean;
  /** Voice: claims in spoken audio that no tool result backs (audio can't be rewritten). */
  flags?: string[];
}

/** Applies one step/escalation/error event from the agent to a message (chat SSE and voice bridge). */
export function applyAgentEvent(m: ChatMessage, e: AgentEvent): ChatMessage {
  switch (e.type) {
    case "step_started":
      return m.steps.some((s) => s.stepId === e.stepId)
        ? m
        : { ...m, steps: [...m.steps, { stepId: e.stepId, tool: e.tool, label: e.label, status: "running" }] };
    case "step_completed": {
      const exists = m.steps.some((s) => s.stepId === e.stepId);
      const done: Step = { stepId: e.stepId, tool: e.tool, label: e.label, status: e.ok ? "ok" : "error", durationMs: e.durationMs, summary: e.summary };
      return { ...m, steps: exists ? m.steps.map((s) => (s.stepId === e.stepId ? done : s)) : [...m.steps, done] };
    }
    case "escalation":
      return { ...m, escalation: { kind: e.kind, reason: e.reason, ticket: e.ticket } };
    case "error":
      return { ...m, error: { code: e.code, message: e.message, retryable: e.retryable, tool: e.tool } };
    case "retrying":
      return { ...m, retrying: { attempt: e.attempt, attempts: e.attempts, reason: e.reason } };
    default:
      return m;
  }
}

const SESSION_KEY = "fernway.sessionId";

function newId(): string {
  return crypto.randomUUID();
}

/** Session id persisted in localStorage, read through useSyncExternalStore (null during SSR). */
const sessionListeners = new Set<() => void>();
const sessionStore = {
  subscribe(fn: () => void) {
    sessionListeners.add(fn);
    return () => sessionListeners.delete(fn);
  },
  get(): string {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = newId();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  },
  rotate(): void {
    localStorage.setItem(SESSION_KEY, newId());
    sessionListeners.forEach((fn) => fn());
  },
};

/** Parses `data: {...}` frames from an SSE byte stream. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
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

export function useChat() {
  const sessionId = useSyncExternalStore(sessionStore.subscribe, sessionStore.get, () => null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  /** Increments after every finished turn, so the trace drawer knows to refresh. */
  const [turnVersion, setTurnVersion] = useState(0);
  const lastUserText = useRef<string>("");

  // Restore the transcript for this session (after a reload or a new conversation).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/chat?sessionId=${sessionId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { transcript: { seq: number; role: string; text: string; channel?: string; interrupted?: boolean }[] } | null) => {
        if (!data) return;
        const restored: ChatMessage[] = [];
        for (const line of data.transcript) {
          if (line.role === "user" || line.role === "assistant") {
            restored.push({
              id: `h${line.seq}`,
              role: line.role,
              text: line.text,
              steps: [],
              channel: line.channel === "voice" ? "voice" : "chat",
              interrupted: line.interrupted,
            });
          } else if (line.role === "ticket" && restored.length) {
            const last = restored[restored.length - 1];
            const [ticketNumber, prio] = line.text.split(" ");
            last.escalation = {
              kind: "ticket",
              reason: "",
              ticket: { ticketNumber, priority: prio.replace(/[()]/g, "") as TicketSummary["priority"], responseTarget: "" },
            };
          }
        }
        // Only fill an empty list: a message sent while this request was in flight must not be overwritten.
        if (!cancelled) setMessages((prev) => (prev.length === 0 ? restored : prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const update = (id: string, fn: (m: ChatMessage) => ChatMessage) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const send = useCallback(
    async (text: string, simulate?: string | null) => {
      if (!sessionId || busy || !text.trim()) return;
      lastUserText.current = text;
      setBusy(true);
      const assistantId = newId();
      setMessages((ms) => [
        ...ms,
        { id: newId(), role: "user", text, steps: [] },
        { id: assistantId, role: "assistant", text: "", steps: [], streaming: true, spans: [] },
      ]);
      // Client-side demo fault: cut the stream mid-turn to exercise resume (not sent to the server).
      const dropStream = simulate === "stream_drop";
      const serverFault = dropStream ? null : simulate;
      let lastSeq = 0;
      let gotDone = false;
      const handle = (e: SseEvent) => {
        if (e.seq <= lastSeq) return; // replayed event we already have: no duplicates
        lastSeq = e.seq;
        switch (e.type) {
          case "token":
            update(assistantId, (m) => ({ ...m, text: m.text + e.text, retrying: undefined, reconnecting: undefined }));
            break;
          case "retrying":
          case "step_started":
          case "step_completed":
          case "escalation":
          case "error":
            update(assistantId, (m) => ({ ...applyAgentEvent(m, e), reconnecting: undefined }));
            break;
          case "trace":
            update(assistantId, (m) => ({ ...m, spans: [...(m.spans ?? []), e.span] }));
            break;
          case "done":
            gotDone = true;
            update(assistantId, (m) => ({ ...m, streaming: false, totals: e.totals, retrying: undefined, reconnecting: undefined }));
            break;
        }
      };
      try {
        const ac = new AbortController();
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, message: text, ...(serverFault ? { simulate: serverFault } : {}) }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          const code: ErrorCode = res.status === 429 ? "rate_limited" : "internal";
          update(assistantId, (m) => ({
            ...m,
            streaming: false,
            error: { code, message: body.message ?? "The request failed.", retryable: true },
          }));
          return;
        }
        const streamId = res.headers.get("x-stream-id");
        try {
          for await (const e of readSse(res.body)) {
            handle(e);
            if (dropStream && e.type === "step_completed") ac.abort(); // simulated network drop
          }
        } catch {
          /* dropped: resume below */
        }
        // Stream ended without `done`: reconnect with the last event number; the server replays the rest.
        for (let attempt = 1; !gotDone && streamId && attempt <= 3; attempt++) {
          const after = lastSeq;
          update(assistantId, (m) => ({ ...m, reconnecting: { attempt, after } }));
          try {
            const r = await fetch(`/api/chat/stream?streamId=${streamId}&after=${after}`, { cache: "no-store" });
            if (r.ok && r.body) for await (const e of readSse(r.body)) handle(e);
          } catch {
            await new Promise((x) => setTimeout(x, 500 * attempt));
          }
          if (gotDone) update(assistantId, (m) => ({ ...m, resumedAfter: after }));
        }
        if (!gotDone) throw new Error("stream lost");
      } catch {
        update(assistantId, (m) => ({
          ...m,
          reconnecting: undefined,
          error: { code: "internal", message: "Connection lost. Check your network and retry.", retryable: true },
        }));
      } finally {
        update(assistantId, (m) => ({ ...m, streaming: false, retrying: undefined }));
        setBusy(false);
        setTurnVersion((v) => v + 1);
      }
    },
    [sessionId, busy],
  );

  const retry = useCallback(() => send(lastUserText.current), [send]);

  /** Insert or update a message by id (used by voice for live transcripts and step indicators). */
  const upsert = useCallback((id: string, make: () => ChatMessage, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => (ms.some((m) => m.id === id) ? ms.map((m) => (m.id === id ? fn(m) : m)) : [...ms, fn(make())]));
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    sessionStore.rotate();
  }, []);

  return { sessionId, messages, busy, send, retry, reset, upsert, turnVersion };
}
