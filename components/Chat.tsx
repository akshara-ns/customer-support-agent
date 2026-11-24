"use client";

import { useEffect, useRef, useState } from "react";
import { useChat, type ChatMessage, type Step } from "@/components/useChat";
import { VoiceBar } from "@/components/voice/VoiceBar";
import { VoiceDebugPanel } from "@/components/voice/VoiceDebugPanel";
import { useVoice } from "@/components/voice/useVoice";

function StepRow({ step }: { step: Step }) {
  return (
    <li className={`step step-${step.status}`}>
      <span className="step-icon" aria-hidden>
        {step.status === "running" ? <span className="spinner" /> : step.status === "ok" ? "✓" : "✕"}
      </span>
      <span className="step-label">{step.status === "running" ? step.label : step.summary ?? step.label}</span>
      {step.durationMs !== undefined && <span className="step-ms">{(step.durationMs / 1000).toFixed(1)}s</span>}
    </li>
  );
}

function EscalationCard({ m, onCreate }: { m: ChatMessage; onCreate: () => void }) {
  const e = m.escalation;
  if (!e) return null;
  if (e.kind === "ticket" && e.ticket) {
    return (
      <div className="escalation escalation-ticket" role="status">
        <strong>Handed to a human · {e.ticket.ticketNumber}</strong>
        <span>
          Priority {e.ticket.priority}
          {e.ticket.responseTarget && ` · first response within ${e.ticket.responseTarget}`}
        </span>
      </div>
    );
  }
  return (
    <div className="escalation escalation-suggested" role="status">
      <strong>Not confident enough to answer</strong>
      <span>The knowledge base doesn&apos;t cover this reliably ({e.reason.replace(/_/g, " ")}).</span>
      <button type="button" onClick={onCreate}>
        Create a ticket for a human
      </button>
    </div>
  );
}

export function Chat({ voiceDebug = false }: { voiceDebug?: boolean }) {
  const { sessionId, messages, busy, send, retry, reset, upsert } = useChat();
  const voice = useVoice({ sessionId, upsert, debug: voiceDebug });
  const [voiceOpen, setVoiceOpen] = useState(voiceDebug);
  const voiceActive = voice.state === "live" || voice.state === "connecting" || voice.state === "reconnecting";
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text);
  };

  return (
    <section className="chat" aria-label="Support chat">
      <header className="chat-header">
        <div>
          <h1>Fernway Support</h1>
          <p className="muted small">
            Session <code>{sessionId ? sessionId.slice(0, 8) : "…"}</code>
          </p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={voiceOpen ? "" : "secondary"}
            onClick={() => {
              if (voiceActive) voice.stop();
              setVoiceOpen((v) => !v);
            }}
            aria-pressed={voiceOpen}
          >
            {voiceOpen ? "Voice on" : "Voice"}
          </button>
          <button type="button" className="secondary" onClick={reset} disabled={busy || voiceActive}>
            New conversation
          </button>
        </div>
      </header>
      {voiceOpen && <VoiceBar voice={voice} allowClips={voiceDebug} />}
      {voiceDebug && <VoiceDebugPanel voice={voice} />}

      <div className="messages" aria-live="polite">
        {messages.length === 0 && (
          <p className="empty muted">
            Ask about plans, refunds or troubleshooting. To act on an account, give the email and support PIN of a demo user.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}${m.channel === "voice" ? " msg-voice" : ""}`}>
            {m.channel === "voice" && <span className="voice-tag small muted">voice</span>}
            {m.steps.length > 0 && (
              <ul className="steps">
                {m.steps.map((s) => (
                  <StepRow key={s.stepId} step={s} />
                ))}
              </ul>
            )}
            {(m.text || (m.streaming && m.steps.length === 0)) && (
              <div className="bubble">
                {m.text}
                {m.streaming && <span className="caret" aria-hidden />}
                {m.interrupted && <span className="interrupted-tag"> interrupted</span>}
              </div>
            )}
            {m.flags && m.flags.length > 0 && (
              <div className="claim-flag small" role="alert">
                Spoken claim not backed by a tool result: {m.flags.join("; ")}
              </div>
            )}
            <EscalationCard m={m} onCreate={() => void send("Please create an escalation ticket so a human can help with this.")} />
            {m.error && (
              <div className="error-banner" role="alert">
                <span>{m.error.message}</span>
                {m.error.retryable && !busy && (
                  <button type="button" onClick={() => void retry()}>
                    Retry
                  </button>
                )}
              </div>
            )}
            {m.totals && m.role === "assistant" && (
              <p className="meta muted small">
                {(m.totals.durationMs / 1000).toFixed(1)}s · {m.totals.tokensIn + m.totals.tokensOut} tokens · ${m.totals.costUsd.toFixed(4)}
              </p>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={voiceActive ? "Voice is on: speak, or end voice to type" : busy ? "Working…" : "Type a message"}
          disabled={busy || !sessionId || voiceActive}
          maxLength={2000}
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
