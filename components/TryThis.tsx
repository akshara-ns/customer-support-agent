"use client";

import { useSyncExternalStore } from "react";
import { fillChatInput, TRY_PROMPTS } from "@/components/tryPrompts";

const DISMISSED_KEY = "fernway.tryThisDismissed";
const CHANGED = "fernway:try-this-changed";

const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(CHANGED, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(CHANGED, cb);
  };
};
const setDismissed = (dismissed: boolean) => {
  if (dismissed) localStorage.setItem(DISMISSED_KEY, "1");
  else localStorage.removeItem(DISMISSED_KEY);
  window.dispatchEvent(new Event(CHANGED));
};

/** A dismissible panel of example prompts for reviewers; clicking one fills the chat input. */
export function TryThis() {
  // Shown on the server render; hidden on the client if the reviewer dismissed it before.
  const dismissed = useSyncExternalStore(subscribe, () => localStorage.getItem(DISMISSED_KEY) === "1", () => false);
  if (dismissed) {
    return (
      <button type="button" className="secondary small try-reopen" onClick={() => setDismissed(false)}>
        Show example prompts
      </button>
    );
  }
  return (
    <aside className="try-this" aria-label="Try this">
      <div className="demo-row">
        <h2>Try this</h2>
        <span className="spacer" />
        <button
          type="button"
          className="link small"
          aria-label="Dismiss example prompts"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
      <p className="muted small">Click a prompt to put it in the chat box, then press Send. In order:</p>
      <ol className="try-list">
        {TRY_PROMPTS.map((p) => (
          <li key={p.label}>
            <button type="button" className="try-prompt" onClick={() => fillChatInput(p.text)}>
              <span className="small muted">{p.label}</span>
              <span>{p.text}</span>
            </button>
          </li>
        ))}
      </ol>
      <ul className="muted small try-notes">
        <li>
          <strong>Voice:</strong> press <em>Voice</em>, ask a question, and interrupt the answer mid-sentence.
        </li>
        <li>
          <strong>Failure simulation:</strong> open <em>Trace</em>, pick a fault (e.g. LLM 429), then send a message.
        </li>
        <li>
          <strong>Observability:</strong> <em>Trace</em> shows each turn&apos;s spans, latency, tokens and estimated cost.
        </li>
        <li>Refunds change shared demo data; it resets daily.</li>
      </ul>
    </aside>
  );
}
