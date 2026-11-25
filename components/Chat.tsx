"use client";


import { useEffect, useRef, useState } from "react";
import { FILL_CHAT_EVENT } from "@/components/tryPrompts";
import { accountStatus, CONVERSATION_RESET_EVENT, MESSAGE_SENT_EVENT, statusLabel } from "@/components/chatUi";
import { useChat, type ChatMessage, type Step } from "@/components/useChat";
import { VoiceBar } from "@/components/voice/VoiceBar";
import { VoiceDebugPanel } from "@/components/voice/VoiceDebugPanel";
import { useVoice } from "@/components/voice/useVoice";
import { FAULT_OPTIONS, TraceDrawer } from "@/components/TraceDrawer";
import { escalationReasonText, type ClientFault, type DemoUser } from "@/lib/contracts";

/** A distinct, friendly state per failure type, with the actions that make sense for it. */
function errorCopy(code: string, tool?: string): { text: string; actions: ("retry" | "refund_again" | "ticket")[] } {
  switch (code) {
    case "llm_timeout":
      return { text: "The assistant took too long to respond. Nothing was changed.", actions: ["retry"] };
    case "llm_rate_limited":
      return { text: "The assistant is busy right now (rate limited). Please retry in a moment.", actions: ["retry"] };
    case "llm_unavailable":
      return { text: "The assistant is unavailable right now. Nothing was changed.", actions: ["retry"] };
    case "tool_failed":
      return tool === "issue_refund"
        ? { text: "Couldn't complete the refund; nothing was refunded. You can try again safely, or I can open a ticket.", actions: ["refund_again", "ticket"] }
        : { text: "A step couldn't be completed. Nothing was changed.", actions: ["retry", "ticket"] };
    case "retrieval_unavailable":
      return { text: "The knowledge base is temporarily unavailable, so I can't look that up right now.", actions: ["retry", "ticket"] };
    case "rate_limited":
      return { text: "You're sending messages too quickly. Please wait a moment.", actions: ["retry"] };
    default:
      return { text: "Something went wrong on our side.", actions: ["retry"] };
  }
}

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
        {e.confidence !== undefined && (
          <span className="small">
            Reason: {escalationReasonText(e.reason)} · confidence: low
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="escalation escalation-suggested" role="status">
      <strong>Not confident enough to answer</strong>
      <span>
        The knowledge base doesn&apos;t cover this reliably ({escalationReasonText(e.reason)}
        {e.confidence !== undefined && ", confidence: low"}). Verify your account to have a person pick it up.
      </span>
      <button type="button" onClick={onCreate}>
        Create a ticket for a human
      </button>
    </div>
  );
}

const MicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);
const ChartIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

export function Chat({ voiceDebug = false, accounts = [] }: { voiceDebug?: boolean; accounts?: DemoUser[] }) {
  const { sessionId, messages, busy, send, retry, reset, upsert, turnVersion } = useChat();
  const [fault, setFault] = useState<ClientFault | "">("");
  const faultRef = useRef<ClientFault | "">("");
  const chooseFault = (f: ClientFault | "") => {
    faultRef.current = f;
    setFault(f);
  };
  /** One-shot: the selected fault applies to the next turn / voice tool call only. */
  const takeFault = () => {
    const f = faultRef.current || null;
    if (f) chooseFault("");
    return f;
  };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const voice = useVoice({ sessionId, upsert, debug: voiceDebug, takeFault });
  const [voiceOpen, setVoiceOpen] = useState(voiceDebug);
  const voiceActive = voice.state === "live" || voice.state === "connecting" || voice.state === "reconnecting";
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // "Try this" panel: a clicked example prompt fills the input (the reviewer still presses Send).
  useEffect(() => {
    const fill = (e: Event) => {
      setDraft((e as CustomEvent<string>).detail);
      inputRef.current?.focus();
    };
    window.addEventListener(FILL_CHAT_EVENT, fill);
    return () => window.removeEventListener(FILL_CHAT_EVENT, fill);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text, takeFault());
    window.dispatchEvent(new CustomEvent<string>(MESSAGE_SENT_EVENT, { detail: text }));
  };
  const status = accountStatus(messages, accounts);
  const armedFault = FAULT_OPTIONS.find((o) => o.value === fault && o.value !== "");

  return (
    <>
    <section className="chat" aria-label="Support chat">
      <header className="chat-header">
        <div className="title-block">
          <h1>Fernway Support</h1>
          <span className={`status-chip ${status.verified ? "status-verified" : "status-unverified"}`} role="status">
            {statusLabel(status)}
          </span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className={`icon-btn${voiceOpen ? " voice-on" : ""}`}
            onClick={() => {
              if (voiceActive) voice.stop();
              setVoiceOpen((v) => !v);
            }}
            aria-pressed={voiceOpen}
          >
            <MicIcon />
            {voiceOpen ? "Voice on" : "Voice"}
          </button>
          <button type="button" className={`icon-btn ${drawerOpen ? "" : "secondary"}`} onClick={() => setDrawerOpen((o) => !o)} aria-pressed={drawerOpen}>
            <ChartIcon />
            Trace &amp; metrics{fault ? " ⚠" : ""}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              reset();
              window.dispatchEvent(new Event(CONVERSATION_RESET_EVENT));
            }}
            disabled={busy || voiceActive}
          >
            New conversation
          </button>
        </div>
      </header>
      {voiceOpen && <VoiceBar voice={voice} allowClips={voiceDebug} />}
      {voiceDebug && <VoiceDebugPanel voice={voice} />}

      <div className="messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p className="empty-title">Hi, I&apos;m the Fernway support assistant.</p>
            <ul className="empty-list muted small">
              <li>
                <strong>Plans &amp; policies:</strong> limits, refund windows, what each tier includes
              </li>
              <li>
                <strong>Refunds:</strong> verified, checked against your plan&apos;s policy in code
              </li>
              <li>
                <strong>Troubleshooting:</strong> sign-in, sync, integrations
              </li>
            </ul>
            {!voiceDebug && (
              <p className="small">
                New here? Try the prompts <span className="hint-wide">on the right →</span>
                <span className="hint-narrow">below ↓</span>
              </p>
            )}
          </div>
        )}
        {messages
          .filter((m) => m.channel !== "voice" || m.text || m.steps.length || m.escalation || m.streaming)
          .map((m) => (
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
            {m.reconnecting && (
              <div className="retry-banner small" role="status">
                <span className="spinner" /> Connection dropped. Reconnecting to the stream from event {m.reconnecting.after}… (attempt {m.reconnecting.attempt})
              </div>
            )}
            {m.retrying && (
              <div className="retry-banner small" role="status">
                <span className="spinner" /> The assistant is busy, retrying… (attempt {m.retrying.attempt} of {m.retrying.attempts}
                {m.retrying.reason === "llm_rate_limited" ? ", rate limited" : m.retrying.reason === "llm_timeout" ? ", timed out" : ""})
              </div>
            )}
            {m.error &&
              (() => {
                const c = errorCopy(m.error.code, m.error.tool);
                return (
                  <div className={`error-banner error-${m.error.code}`} role="alert">
                    <span>{c.text}</span>
                    {!busy && !voiceActive && c.actions.includes("retry") && m.error.retryable && (
                      <button type="button" onClick={() => void retry()}>
                        Retry
                      </button>
                    )}
                    {!busy && !voiceActive && c.actions.includes("refund_again") && (
                      <button type="button" onClick={() => void send("Please try the refund again.")}>
                        Try the refund again
                      </button>
                    )}
                    {!busy && !voiceActive && c.actions.includes("ticket") && (
                      <button type="button" className="secondary" onClick={() => void send("Please open an escalation ticket for this.")}>
                        Open a ticket
                      </button>
                    )}
                  </div>
                );
              })()}
            {m.totals && m.role === "assistant" && (
              <p className="meta muted small">
                {(m.totals.durationMs / 1000).toFixed(1)}s{m.totals.ttftMs !== undefined ? ` · first token ${(m.totals.ttftMs / 1000).toFixed(1)}s` : ""} ·{" "}
                {m.totals.tokensIn + m.totals.tokensOut} tokens · est. ${m.totals.costUsd.toFixed(4)}
                {m.resumedAfter !== undefined ? ` · stream resumed after event ${m.resumedAfter}` : ""}
              </p>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {armedFault && (
        <div className="fault-banner small" role="status">
          Next message will simulate: <strong>{armedFault.label}</strong> ·{" "}
          <button type="button" className="link" onClick={() => chooseFault("")}>
            Cancel
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={voiceActive ? "Voice is on: speak, or end voice to type" : busy ? "Working…" : "Ask about plans, refunds, troubleshooting… or press Voice to talk."}
          disabled={busy || !sessionId || voiceActive}
          maxLength={2000}
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </section>
    {drawerOpen && (
      <TraceDrawer
        sessionId={sessionId}
        refreshKey={turnVersion}
        fault={fault}
        onFault={chooseFault}
        onClose={() => setDrawerOpen(false)}
        live={voiceActive}
      />
    )}
    </>
  );
}
