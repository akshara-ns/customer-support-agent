/** Trace correctness: tool spans show errors with their type; voice rows carry real durations. */
import { describe, expect, it } from "vitest";
import { Trace } from "@/lib/observability/trace";
import { MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import { runToolStep } from "@/lib/tools/step";
import { recordVoiceEvent, type TraceWriter } from "@/lib/voice/bridge";

const NOW = new Date("2026-11-23T12:00:00Z");

describe("trace correctness", () => {
  it("a tool that returns a typed error produces an error span with the error code", async () => {
    const trace = new Trace();
    const tools = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy: { search: async () => ({ status: "needs_escalation" as const, reason: "x", confidence: 0 }) }, now: () => NOW };
    await runToolStep({
      sessionId: "s",
      turnId: trace.turnId,
      channel: "chat",
      stepId: "x",
      call: { id: "c1", name: "verify_identity", arguments: JSON.stringify({ email: "omar@example.com", code: "000000" }) },
      ctx: { sessionId: "s", turnId: trace.turnId, customer: null, failedVerifications: 0, trace },
      deps: tools,
      events: new MemoryEventStore(),
      emit: () => {},
      trace,
    });
    const span = trace.spans.find((s) => s.kind === "tool");
    expect(span).toMatchObject({ status: "error", error: "VERIFICATION_FAILED" });
  });

  it("a realtime usage row records the response's real duration", async () => {
    const rows: Parameters<TraceWriter["write"]>[0][] = [];
    await recordVoiceEvent(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      { kind: "usage", model: "gpt-realtime-2.1-mini", usage: { input_tokens: 10, output_tokens: 5 }, durationMs: 1840 },
      { events: new MemoryEventStore(), traces: { write: async (r) => void rows.push(r) } },
    );
    expect(rows[0]).toMatchObject({ name: "realtime_response:gpt-realtime-2.1-mini", durationMs: 1840 });
  });
});
