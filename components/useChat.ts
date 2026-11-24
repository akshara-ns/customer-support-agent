"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { applyAgentEvent, type ChatMessage } from "@/components/agentEvents";
import type { ClientFault, TranscriptResponse } from "@/lib/contracts";
import type { ErrorCode, SseEvent } from "@/lib/types";

export type { ChatMessage, Step } from "@/components/agentEvents";

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
      .then((data: TranscriptResponse | null) => {
        if (!data) return;
        const restored: ChatMessage[] = data.transcript.map((line) => ({
          id: `h${line.seq}`,
          role: line.role,
          text: line.text,
          steps: (line.steps ?? []).map((st) => ({ stepId: st.stepId, tool: st.tool, label: st.label, status: st.status, summary: st.summary })),
          channel: line.channel,
          interrupted: line.interrupted,
          ...(line.ticket ? { escalation: { kind: "ticket" as const, reason: "", ticket: line.ticket } } : {}),
        }));
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
    async (text: string, simulate?: ClientFault | null) => {
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
