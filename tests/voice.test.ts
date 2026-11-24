import { beforeEach, describe, expect, it, vi } from "vitest";
import { runToolStep } from "@/lib/tools/step";
import { buildContext, MemoryEventStore } from "@/lib/session/events";
import { customerDirectory } from "@/lib/tools/customers";
import { MemoryLedger, MemoryTickets } from "@/lib/tools/memory-stores";
import type { PolicySearch, ToolDeps } from "@/lib/tools/stores";
import { realtimeCostUsd, recordVoiceEvent, runVoiceTool, type TraceWriter } from "@/lib/voice/bridge";
import { createVoiceSession, openAISecretMinter, REALTIME_TOOLS, voiceSessionConfig, type VoiceSessionConfig } from "@/lib/voice/session";

const NOW = new Date("2026-11-23T12:00:00Z");
const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const policy: PolicySearch = { search: async () => ({ status: "needs_escalation", reason: "low_retrieval_confidence", confidence: 0.1 }) };

let events: MemoryEventStore;
let tools: ToolDeps;
let traces: TraceWriter & { rows: unknown[] };
beforeEach(() => {
  events = new MemoryEventStore();
  tools = { customers: customerDirectory(NOW), ledger: new MemoryLedger(), tickets: new MemoryTickets(), policy, now: () => NOW };
  const rows: unknown[] = [];
  traces = { rows, write: async (r) => void rows.push(r) };
});

const verifyInChat = () =>
  runToolStep({
    sessionId: SESSION,
    turnId: TURN,
    channel: "chat",
    stepId: "s1",
    call: { id: "c1", name: "verify_identity", arguments: JSON.stringify({ email: "omar@example.com", code: "715204" }) },
    ctx: { sessionId: SESSION, turnId: TURN, customer: null, failedVerifications: 0 },
    deps: tools,
    events,
    emit: () => {},
  });

const POLICY_OK = { status: "answered" as const, answer: "x", citations: [], confidence: 0.5, tier_scope: "general" as const };

describe("voice token endpoint", () => {
  it("returns only the ephemeral key; the server key is used for the call but never returned", async () => {
    const SERVER_KEY = "sk-test-server-key-should-never-leak";
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVER_KEY}`);
      const body = JSON.parse(String(init?.body)) as { session: VoiceSessionConfig; expires_after: { seconds: number } };
      expect(body.session.model).toBe("gpt-realtime-2.1-mini");
      expect(body.expires_after.seconds).toBeLessThanOrEqual(60);
      return new Response(JSON.stringify({ value: "ek_test123", expires_at: 1_900_000_000, session: body.session }), { status: 200 });
    });
    const session = await createVoiceSession(SESSION, { events, tools, mint: openAISecretMinter(SERVER_KEY, fetchImpl as typeof fetch) });
    expect(session.clientSecret).toBe("ek_test123");
    const json = JSON.stringify(session);
    expect(json).not.toContain(SERVER_KEY);
    expect(json).not.toMatch(/sk-[A-Za-z0-9-]/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses a minting response that isn't an ephemeral key", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ value: "sk-oops" }), { status: 200 })) as typeof fetch;
    await expect(openAISecretMinter("sk-x", fetchImpl)(voiceSessionConfig("x"))).rejects.toThrow(/no ephemeral key/);
  });

  it("is rate limited before any key is minted", async () => {
    vi.resetModules();
    const mint = vi.fn();
    vi.doMock("@/lib/ratelimit", () => ({
      consumeLimits: async () => ({ allowed: false, bucket: "voice_session:ip", count: 7, limit: 6, retryAfterSec: 120 }),
      rateLimitedResponse: (r: { retryAfterSec: number }) =>
        Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(r.retryAfterSec) } }),
    }));
    vi.doMock("@/lib/voice/session", () => ({ createVoiceSession: mint, openAISecretMinter: vi.fn() }));
    vi.doMock("@/lib/server/deps", () => ({ productionEvents: {}, productionToolDeps: () => ({}) }));
    vi.doMock("@/lib/env", () => ({ serverEnv: () => ({ OPENAI_API_KEY: "sk-test" }) }));
    const { POST } = await import("@/app/api/voice/session/route");
    const res = await POST(new Request("http://x/api/voice/session", { method: "POST", body: JSON.stringify({ sessionId: SESSION }) }));
    expect(res.status).toBe(429);
    expect(mint).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/ratelimit");
    vi.doUnmock("@/lib/voice/session");
    vi.doUnmock("@/lib/server/deps");
    vi.doUnmock("@/lib/env");
  });

  it("exposes the same tools to voice as to chat", () => {
    expect(REALTIME_TOOLS.map((t) => t.name)).toEqual(["verify_identity", "get_policy", "issue_refund", "create_escalation_ticket"]);
  });

  it("carries chat verification and history into the voice session", async () => {
    await events.append(SESSION, TURN, "chat", { type: "user_message", text: "hello" });
    await verifyInChat();
    await events.append(SESSION, TURN, "chat", { type: "assistant_message", text: "You're verified." });
    const s = await createVoiceSession(SESSION, { events, tools, mint: async () => ({ value: "ek_1", expiresAt: 0 }) });
    expect(s.verified).toBe(true);
    expect(s.history).toEqual([
      { role: "user", text: "hello", channel: "chat" },
      { role: "assistant", text: "You're verified.", channel: "chat" },
    ]);
  });
});

describe("voice tool bridge", () => {
  it("gives the same policy outcome as chat for the same inputs", async () => {
    await verifyInChat();
    const args = JSON.stringify({ invoice_id: "inv_2003", amount_usd: 900, reason: "fewer seats" });
    const voice = await runVoiceTool({ sessionId: SESSION, turnId: TURN, callId: "v1", name: "issue_refund", arguments: args }, { events, tools });
    const chat = await runToolStep({
      sessionId: SESSION,
      turnId: TURN,
      channel: "chat",
      stepId: "s2",
      call: { id: "c2", name: "issue_refund", arguments: args },
      ctx: { sessionId: SESSION, turnId: TURN, customer: { customerId: "cus_pro_omar", tier: "pro", contractStatus: "active" }, failedVerifications: 0 },
      deps: tools,
      events,
      emit: () => {},
    });
    expect(JSON.parse(voice.output)).toEqual({ ok: false, error: (chat.outcome.result as { error: unknown }).error });
    expect(JSON.parse(voice.output).error.code).toBe("OVER_TIER_LIMIT");
    expect(voice.events.map((e) => e.type)).toEqual(["step_started", "step_completed"]);
  });

  it("requires verification (state comes from the shared log, not the browser)", async () => {
    const r = await runVoiceTool(
      { sessionId: SESSION, turnId: TURN, callId: "v1", name: "issue_refund", arguments: JSON.stringify({ invoice_id: "inv_2004", amount_usd: 29, reason: "x" }) },
      { events, tools },
    );
    expect(JSON.parse(r.output).error.code).toBe("NOT_VERIFIED");
  });

  it("uses a chat verification for a voice refund and logs it on the voice channel", async () => {
    await verifyInChat();
    const r = await runVoiceTool(
      { sessionId: SESSION, turnId: TURN, callId: "v2", name: "issue_refund", arguments: JSON.stringify({ invoice_id: "inv_2004", amount_usd: 29, reason: "x" }) },
      { events, tools },
    );
    expect(r.ok).toBe(true);
    const log = await events.list(SESSION);
    expect(log.filter((e) => e.channel === "voice").map((e) => e.event.type)).toEqual(["tool_call", "tool_result"]);
  });
});

describe("voice session log", () => {
  it("appends voice transcripts to the same session, in order", async () => {
    await recordVoiceEvent(SESSION, TURN, { kind: "user_transcript", text: "What's my refund window?" }, { events, traces });
    await recordVoiceEvent(SESSION, TURN, { kind: "assistant_transcript", text: "Thirty days.", interrupted: false }, { events, traces });
    const log = await events.list(SESSION);
    expect(log.map((e) => [e.seq, e.channel, e.event.type])).toEqual([
      [1, "voice", "user_message"],
      [2, "voice", "assistant_message"],
    ]);
  });

  it("flags a spoken claim that no tool result in the turn backs, and records interruptions", async () => {
    const bad = await recordVoiceEvent(SESSION, TURN, { kind: "assistant_transcript", text: "Your refund has been issued.", interrupted: true }, { events, traces });
    expect(bad.flags[0]).toMatch(/claimed a refund/);
    const last = (await events.list(SESSION)).at(-1)?.event;
    expect(last).toMatchObject({ type: "assistant_message", interrupted: true });

    await verifyInChat();
    await runVoiceTool(
      { sessionId: SESSION, turnId: TURN, callId: "v3", name: "issue_refund", arguments: JSON.stringify({ invoice_id: "inv_2004", amount_usd: 29, reason: "x" }) },
      { events, tools },
    );
    const ok = await recordVoiceEvent(SESSION, TURN, { kind: "assistant_transcript", text: "Your refund of $29 has been issued.", interrupted: false }, { events, traces });
    expect(ok.flags).toEqual([]);
  });

  it("records realtime usage with an estimated cost", async () => {
    const usage = { input_tokens: 1000, output_tokens: 500, input_token_details: { audio_tokens: 800, text_tokens: 200 }, output_token_details: { audio_tokens: 400, text_tokens: 100 } };
    const r = await recordVoiceEvent(SESSION, TURN, { kind: "usage", model: "gpt-realtime-2.1-mini", usage }, { events, traces });
    const expected = (800 * 10 + 200 * 0.6 + 400 * 20 + 100 * 2.4) / 1e6;
    expect(r.costUsd).toBeCloseTo(expected, 10);
    expect(realtimeCostUsd("unknown-model", usage)).toBe(0);
    expect(traces.rows).toHaveLength(1);
  });

  it("keeps a tool call next to its result even if a voice transcript was logged in between", async () => {
    await events.append(SESSION, TURN, "voice", { type: "user_message", text: "refund please" });
    await events.append(SESSION, TURN, "voice", { type: "tool_call", toolCallId: "t1", name: "get_policy", arguments: "{}" });
    await events.append(SESSION, TURN, "voice", { type: "user_message", text: "late transcript" });
    await events.append(SESSION, TURN, "voice", { type: "tool_result", toolCallId: "t1", name: "get_policy", result: { ok: true, data: POLICY_OK }, effects: {} });
    const ctx = buildContext(await events.list(SESSION));
    const i = ctx.findIndex((m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls);
    expect(ctx[i + 1]).toMatchObject({ role: "tool", tool_call_id: "t1" });
  });
});
