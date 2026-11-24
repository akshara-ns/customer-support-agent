"use client";

import { useEffect, useState } from "react";
import type { HealthResponse } from "@/lib/types";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; health: HealthResponse }
  | { kind: "failed"; message: string };

export function HealthStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (res) => setState({ kind: "loaded", health: (await res.json()) as HealthResponse }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setState({ kind: "failed", message: err instanceof Error ? err.message : "request failed" });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "loading") return <p className="health">Checking backend…</p>;
  if (state.kind === "failed") return <p className="health health-error">Backend unreachable: {state.message}</p>;

  const { health } = state;
  return (
    <div className={`health ${health.status === "ok" ? "health-ok" : "health-error"}`}>
      <strong>Backend: {health.status}</strong>
      <ul>
        <li>Database: {health.db.ok ? "connected" : `error${health.db.error ? `: ${health.db.error}` : ""}`}</li>
        <li>pgvector: {health.db.pgvector ?? "missing"}</li>
        <li>Migrations applied: {health.db.migrations}</li>
        <li>DB latency: {health.db.latencyMs} ms</li>
        {health.commit && <li>Commit: {health.commit}</li>}
      </ul>
    </div>
  );
}
