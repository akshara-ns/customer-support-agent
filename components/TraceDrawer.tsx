"use client";

import { useCallback, useEffect, useState } from "react";

interface SpanNode {
  id: string;
  kind: string;
  name: string;
  status: "ok" | "error";
  startMs: number;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  tokensCached: number | null;
  costUsd: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  children: SpanNode[];
}

interface Turn {
  turnId: string;
  channel: "chat" | "voice";
  startedAt: string;
  durationMs: number;
  ttftMs: number | null;
  state: string | null;
  tokens: { in: number; out: number; cached: number };
  costUsd: number;
  tools: { name: string; durationMs: number; status: string; error?: string }[];
  guardrails: { name: string; detail: unknown }[];
  corrections: unknown[];
  retries: unknown[];
  spans: SpanNode[];
}

interface Report {
  sessionId: string;
  turns: Turn[];
  summary: {
    turns: number;
    chatTurnMs: { p50: number | null; p95: number | null };
    ttftMs: { p50: number | null; p95: number | null };
    voiceResponseMs: { p50: number | null; p95: number | null };
    tokens: { in: number; out: number; cached: number };
    costUsd: { chat: number; voice: number; total: number };
  };
  systemPrompt: string;
  pricing: { checked: string; source: string; note: string };
}

export const FAULT_OPTIONS = [
  { value: "", label: "None" },
  { value: "llm_timeout", label: "LLM timeout (all retries time out)" },
  { value: "llm_rate_limit", label: "LLM 429 rate limit (2 hits, then recovers)" },
  { value: "tool_failure", label: "Refund tool fails after recording the request" },
  { value: "retrieval_down", label: "Knowledge base / embeddings unavailable" },
] as const;

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v}ms`);
const usd = (v: number) => `$${v.toFixed(v < 0.01 ? 5 : 4)}`;

function copy(value: unknown) {
  void navigator.clipboard?.writeText(JSON.stringify(value, null, 2));
}

function SpanRow({ s, depth, total }: { s: SpanNode; depth: number; total: number }) {
  const [open, setOpen] = useState(false);
  const left = total > 0 ? (s.startMs / total) * 100 : 0;
  const width = total > 0 ? Math.max(1, (s.durationMs / total) * 100) : 1;
  return (
    <li>
      <button type="button" className={`span-row span-${s.kind} ${s.status === "error" ? "span-err" : ""}`} onClick={() => setOpen((o) => !o)}>
        <span className="span-name" style={{ paddingLeft: depth * 12 }}>
          <span className="kind">{s.kind}</span> {s.name}
        </span>
        <span className="span-bar">
          <span style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
        <span className="span-ms">{ms(s.durationMs)}</span>
      </button>
      {open && (
        <div className="span-detail mono">
          <div>
            start +{ms(s.startMs)} · end +{ms(s.startMs + s.durationMs)}
            {s.tokensIn !== null && ` · in ${s.tokensIn} / out ${s.tokensOut ?? 0}${s.tokensCached ? ` / cached ${s.tokensCached}` : ""}`}
            {s.costUsd !== null && ` · est. ${usd(s.costUsd)}`}
          </div>
          {s.error && <div className="error-text">error: {s.error}</div>}
          {s.input !== null && s.input !== undefined && (
            <details>
              <summary>input (prompt / arguments, redacted)</summary>
              <pre>{JSON.stringify(s.input, null, 2)}</pre>
            </details>
          )}
          {s.output !== null && s.output !== undefined && (
            <details>
              <summary>output</summary>
              <pre>{JSON.stringify(s.output, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {s.children.length > 0 && (
        <ul>
          {s.children.map((c) => (
            <SpanRow key={c.id} s={c} depth={depth + 1} total={total} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TurnCard({ t, index }: { t: Turn; index: number }) {
  const [open, setOpen] = useState(index === 0);
  return (
    <div className="turn-card">
      <button type="button" className="turn-head" onClick={() => setOpen((o) => !o)}>
        <span className={`badge badge-${t.channel === "voice" ? "enterprise" : "pro"}`}>{t.channel}</span>
        <span className="mono small">{new Date(t.startedAt).toLocaleTimeString()}</span>
        <span className="mono small">e2e {ms(t.durationMs)}</span>
        <span className="mono small">{t.channel === "voice" ? "response" : "TTFT"} {ms(t.ttftMs)}</span>
        <span className="mono small">{t.tokens.in + t.tokens.out} tok</span>
        <span className="mono small">est. {usd(t.costUsd)}</span>
        {t.state && <span className={`pill pill-${t.state === "failed" ? "error" : t.state === "escalated" ? "reconnecting" : "live"}`}>{t.state}</span>}
      </button>
      {open && (
        <div className="turn-body">
          {t.tools.length > 0 && (
            <p className="small">
              Tools:{" "}
              {t.tools.map((x, i) => (
                <span key={i} className={x.status === "error" ? "error-text" : ""}>
                  {x.name} {ms(x.durationMs)}
                  {x.error ? ` (${x.error})` : ""}
                  {i < t.tools.length - 1 ? " → " : ""}
                </span>
              ))}
            </p>
          )}
          {t.retries.length > 0 && <p className="small">Retries: {t.retries.map((r) => JSON.stringify(r)).join(" · ")}</p>}
          {t.guardrails.length > 0 && (
            <div className="small">
              Guardrails:
              <ul className="guardrails">
                {t.guardrails.map((g, i) => (
                  <li key={i} className="mono">
                    {g.name}: {JSON.stringify(g.detail).slice(0, 220)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {t.corrections.length > 0 && <p className="small error-text">Claim-check corrections: {JSON.stringify(t.corrections).slice(0, 400)}</p>}
          <p className="small muted">
            tokens in {t.tokens.in} · out {t.tokens.out} · cached {t.tokens.cached}
          </p>
          <ul className="span-tree">
            {t.spans.map((s) => (
              <SpanRow key={s.id} s={s} depth={0} total={t.durationMs} />
            ))}
          </ul>
          <button type="button" className="secondary small-btn" onClick={() => copy(t)}>
            Copy turn trace JSON
          </button>
        </div>
      )}
    </div>
  );
}

export function TraceDrawer({
  sessionId,
  refreshKey,
  fault,
  onFault,
  onClose,
  live,
}: {
  sessionId: string | null;
  refreshKey: number;
  fault: string;
  onFault: (f: string) => void;
  onClose: () => void;
  /** Poll while voice is live (voice turns don't end with a chat `done`). */
  live: boolean;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/traces`, { cache: "no-store" });
      if (!res.ok) throw new Error(((await res.json()) as { message?: string }).message ?? `HTTP ${res.status}`);
      setReport((await res.json()) as Report);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load traces");
    }
  }, [sessionId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load, refreshKey]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [live, load]);

  const s = report?.summary;
  return (
    <aside className="drawer" aria-label="Observability drawer">
      <header className="drawer-head">
        <strong>Observability</strong>
        <span className="spacer" />
        <button type="button" className="secondary small-btn" onClick={() => void load()}>
          Refresh
        </button>
        <button type="button" className="secondary small-btn" onClick={onClose} aria-label="Close drawer">
          ✕
        </button>
      </header>

      <section className="drawer-section">
        <label className="small">
          <strong>Failure simulation</strong> (applies to your next chat turn or voice tool call, once)
          <select value={fault} onChange={(e) => onFault(e.target.value)}>
            {FAULT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && <p className="small error-text">{error}</p>}
      {s && report && (
        <section className="drawer-section small">
          <div className="stats">
            <div>
              <span className="muted">turns</span> {s.turns}
            </div>
            <div>
              <span className="muted">chat turn p50/p95</span> {ms(s.chatTurnMs.p50)} / {ms(s.chatTurnMs.p95)}
            </div>
            <div>
              <span className="muted">TTFT p50/p95</span> {ms(s.ttftMs.p50)} / {ms(s.ttftMs.p95)}
            </div>
            <div>
              <span className="muted">voice response p50/p95</span> {ms(s.voiceResponseMs.p50)} / {ms(s.voiceResponseMs.p95)}
            </div>
            <div>
              <span className="muted">tokens in/out/cached</span> {s.tokens.in} / {s.tokens.out} / {s.tokens.cached}
            </div>
            <div>
              <span className="muted">est. cost</span> {usd(s.costUsd.total)} (chat {usd(s.costUsd.chat)}, voice {usd(s.costUsd.voice)})
            </div>
          </div>
          <p className="muted">
            Estimated cost: {report.pricing.note} Prices checked {report.pricing.checked}; source: {report.pricing.source}.
          </p>
          <details>
            <summary>System prompt (sent first on every chat call)</summary>
            <pre className="mono">{report.systemPrompt}</pre>
          </details>
          <button type="button" className="secondary small-btn" onClick={() => copy(report)}>
            Copy session trace JSON
          </button>
        </section>
      )}

      <section className="drawer-turns">
        {report?.turns.length === 0 && <p className="small muted">No turns yet.</p>}
        {[...(report?.turns ?? [])].reverse().map((t, i) => (
          <TurnCard key={t.turnId} t={t} index={i} />
        ))}
      </section>
    </aside>
  );
}
