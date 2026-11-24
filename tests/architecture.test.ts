/**
 * Layer boundaries, enforced. Layers top to bottom:
 *   ui (components/, app pages) → routes (app/api) → server (lib/server) → orchestration (lib/agent,
 *   lib/voice) → tools (lib/tools) → guardrails (lib/guardrails) → rag (lib/rag) → infra (lib/session,
 *   lib/observability, lib/db, lib/openai, lib/env, lib/log, lib/faults, lib/ratelimit, lib/health, lib/admin, lib/deadline)
 * Shared, client-safe modules (lib/contracts, lib/types, lib/config) may be imported from anywhere.
 * Rule: a runtime import may only point to the same layer or a lower one. The UI may only import
 * components and shared modules (pages may also use the server composition root, lib/server).
 * `import type` is exempt: types don't create runtime dependencies.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHARED = ["lib/contracts.ts", "lib/types.ts", "lib/config.ts"];

const LAYERS: [string, RegExp][] = [
  ["ui", /^(components\/|app\/(?!api\/))/],
  ["routes", /^app\/api\//],
  ["server", /^lib\/server\//],
  ["orchestration", /^lib\/(agent|voice)\//],
  ["tools", /^lib\/tools\//],
  ["guardrails", /^lib\/guardrails\//],
  ["rag", /^lib\/rag\//],
  ["infra", /^lib\/(session|observability|db)\/|^lib\/(openai|env|log|faults|ratelimit|health|admin|deadline)\.ts$/],
];

function layerOf(file: string): number {
  if (SHARED.includes(file) || file.startsWith("data/")) return Number.POSITIVE_INFINITY; // shared code and static data
  const i = LAYERS.findIndex(([, re]) => re.test(file));
  if (i < 0) throw new Error(`file not assigned to a layer: ${file}`);
  return i;
}

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null; // package import
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      if (statSync(path.join(ROOT, candidate)).isFile()) return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Runtime imports only: skips `import type …` and `export type … from`. Inline `type` specifiers still count. */
function runtimeImports(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    const target = resolve(file, m[3]);
    if (target) out.push(target);
  }
  for (const m of src.matchAll(/await import\(["']([^"']+)["']\)/g)) {
    const target = resolve(file, m[1]);
    if (target) out.push(target);
  }
  return out;
}

const files = [...walk("app"), ...walk("components"), ...walk("lib")];

describe("architecture", () => {
  it("assigns every source file to a layer", () => {
    for (const f of files) expect(() => layerOf(f), f).not.toThrow();
  });

  it("never imports upward (UI → routes → server → orchestration → tools → guardrails → rag → infra)", () => {
    const violations: string[] = [];
    for (const f of files) {
      const from = layerOf(f);
      for (const t of runtimeImports(f)) {
        const to = layerOf(t);
        if (to === Number.POSITIVE_INFINITY) continue; // shared contracts/types/config
        const uiFile = LAYERS[0][1].test(f);
        const isPage = /^app\/(?!api\/)/.test(f);
        if (uiFile) {
          const allowed = LAYERS[0][1].test(t) || (isPage && /^lib\/server\//.test(t));
          if (!allowed) violations.push(`${f} → ${t} (UI may only import components and shared modules)`);
          continue;
        }
        if (to < from) violations.push(`${f} [${LAYERS[from][0]}] → ${t} [${LAYERS[to][0]}]`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("has no import cycles between top-level lib modules", () => {
    const mod = (f: string) => (f.startsWith("lib/") ? f.split("/").slice(0, 2).join("/").replace(/\.tsx?$/, "") : null);
    const edges = new Map<string, Set<string>>();
    for (const f of files) {
      const a = mod(f);
      if (!a) continue;
      for (const t of runtimeImports(f)) {
        const b = mod(t);
        if (b && b !== a) edges.set(a, new Set([...(edges.get(a) ?? []), b]));
      }
    }
    const cycles: string[] = [];
    for (const [a, targets] of edges) for (const b of targets) if (edges.get(b)?.has(a)) cycles.push(`${a} ↔ ${b}`);
    expect(cycles).toEqual([]);
  });
});
