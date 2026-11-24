/**
 * One end-to-end deadline per chat turn (senior review): a slow model, a hung tool or a hung ledger
 * write ends the turn with a fallback reply and a `done` event; a refund caught mid-write stays
 * pending and resumes with the same idempotency key.
 */
import { describe, expect, it } from "vitest";
import type { AgentModel, ModelTurn } from "@/lib/agent/model";
import { runTurn } from "@/lib/agent/run";
import { turnSignal } from "@/lib/deadline";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { executeTool } from "@/lib/tools/registry";
import type { PolicySearch, ToolDeps } from "@/lib/tools/stores";
import type { AgentEvent } from "@/lib/types";

const NOW = new Date("2026-11-23T12:00:00Z");
const usage = { model: "s", tokensIn: 1, tokensOut: 1, cachedTokens: 0 };
const never = <T,>() => new Promise<T>(() => {});
const tool = (name: string, args: object): ModelTurn => ({ content: "", toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }], usage });
const POLICY_OK: PolicySearch = { search: async () => ({ status: "answered", answer: "x [a#1]", citations: ["a#1"], confidence: 0.6 }) };

function scripted(steps: (ModelTurn | "hang")[]): AgentModel & { sawSignal: boolean } {
  let i = 0;
  const m = {
    name: "s",
    sawSignal: false,
    async complete() {
      const step = steps[i++] ?? { content: "Done. ", toolCalls: [], usage };
      m.sawSignal ||= turnSignal() !== undefined;
      if (step === "hang") {
        // A slow model call that honours the turn's signal, like the OpenAI client does.
        await new Promise((_, reject) => turnSignal()?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      return step as ModelTurn;
    },
  };
  return m;
}

async function turn(model: AgentModel, tools: Partial<ToolDeps> = {}, message = "please refund $29 on inv_2004") {
  const deps: ToolDeps = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: POLICY_OK, now: () => NOW, ...tools };
  const events = new MemoryEventStore();
  const emitted: AgentEvent[] = [];
  const t0 = Date.now();
  const r = await runTurn({ sessionId: "s-dl", message, channel: "chat" }, { model, events, tools: deps, deadlineMs: 80 }, (e) => emitted.push(e));
  return { r, emitted, ms: Date.now() - t0, deps };
}

describe("turn deadline", () => {
  it("slow model: fallback reply, done event, well within a second; the model call saw the turn signal", async () => {
    const model = scripted(["hang"]);
    const { r, emitted, ms } = await turn(model);
    expect(ms).toBeLessThan(1000);
    expect(r.state).toBe("failed");
    expect(r.reply).toContain("taking longer than it should");
    expect(emitted.at(-1)).toMatchObject({ type: "done", state: "failed" });
    expect(model.sawSignal).toBe(true);
    expect(r.trace.spans.map((s) => s.name)).toContain("turn_deadline");
  });

  it("hung tool (policy search never returns): the turn still ends with a fallback and done", async () => {
    const { r, emitted, ms } = await turn(scripted([tool("get_policy", { question: "What is the refund window?" })]), { policy: { search: never } }, "what is the window?");
    expect(ms).toBeLessThan(1000);
    expect(r.reply).toContain("taking longer than it should");
    expect(emitted.at(-1)?.type).toBe("done");
  });

  it("refund caught mid-write stays pending and resumes with the same key, exactly once", async () => {
    class HangingLedger extends MemoryLedger {
      hang = true;
      override async complete(key: string, status: "succeeded" | "rejected", result: unknown) {
        if (this.hang) return never<void>();
        return super.complete(key, status, result);
      }
    }
    const ledger = new HangingLedger();
    const model = scripted([tool("verify_identity", { email: "omar@example.com", code: "715204" }), tool("issue_refund", { invoice_id: "inv_2004", amount_usd: 29, reason: "seat" })]);
    const { r, deps } = await turn(model, { ledger });
    expect(r.reply).toContain("taking longer than it should");
    expect([...ledger.entries.values()].map((e) => e.status)).toEqual(["pending"]);
    ledger.hang = false;
    const ctx = { sessionId: "s-dl", turnId: "t2", customer: { customerId: "cus_pro_omar", tier: "pro" as const, contractStatus: "active" as const }, failedVerifications: 0 };
    const retry = await executeTool("issue_refund", JSON.stringify({ invoice_id: "inv_2004", amount_usd: 29, reason: "seat" }), ctx, deps);
    expect(retry.result.ok).toBe(true);
    expect([...ledger.entries.values()].map((e) => e.status)).toEqual(["succeeded"]);
  });
});
