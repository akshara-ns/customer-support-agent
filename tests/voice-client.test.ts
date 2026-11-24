/**
 * Voice client logic without a browser: heard-portion cuts, barge-in, the tool bridge, and the
 * response.done → function_call_output → response.create hand-back. WebRTC and audio are not involved.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/components/agentEvents";
import { interruptPlayback } from "@/components/voice/interruption";
import { handleServerEvent, type EventDeps } from "@/components/voice/realtimeEvents";
import { startToolCall } from "@/components/voice/toolBridge";
import { heardPortion } from "@/components/voice/transcript";
import { createRuntime, type Upsert, type VoiceRuntime } from "@/components/voice/types";

function store() {
  const msgs = new Map<string, ChatMessage>();
  const upsert: Upsert = (id, make, fn) => msgs.set(id, fn(msgs.get(id) ?? make()));
  return { msgs, upsert };
}

function harness() {
  const c = createRuntime();
  c.dc = { readyState: "open" } as RTCDataChannel; // only checked for presence after tool calls
  const { msgs, upsert } = store();
  const sent: Record<string, unknown>[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const post = vi.fn(async (url: string, body: unknown) => {
    posts.push({ url, body: body as Record<string, unknown> });
    if (url === "/api/voice/tool") return { output: JSON.stringify({ ok: true, data: { ok: 1 } }), events: [] };
    return { flags: [] };
  }) as unknown as EventDeps["post"];
  const note = vi.fn();
  const send = (o: Record<string, unknown>) => void sent.push(o);
  const deps: EventDeps = {
    note,
    upsert,
    post,
    send,
    sessionId: "s1",
    interrupt: () => interruptPlayback(c, { send, upsert, note, logAssistant: () => {}, setInterruptions: () => {} }),
    startCall: (call) => startToolCall(c, call, { post, sessionId: "s1", upsert, note }),
    logAssistant: () => {},
    setInterruptions: () => {},
    setCostUsd: () => {},
    setError: vi.fn(),
  };
  const ev = (e: Record<string, unknown>) => handleServerEvent(c, JSON.stringify(e), deps);
  return { c, msgs, sent, posts, deps, ev };
}

function responding(c: VoiceRuntime, text: string) {
  c.responses.set("r1", { id: "r1", msgId: "va-r1", turnId: "t1", text, interrupted: false, truncateConfirmed: false, logged: false, calls: [] });
  c.activeResponseId = "r1";
}

describe("heardPortion", () => {
  it("cuts at a word boundary at ~15 chars/second and marks the cut", () => {
    expect(heardPortion("Your refund of one hundred dollars is approved today", 1000)).toBe("Your refund of…");
    expect(heardPortion("Short answer.", 5000)).toBe("Short answer.");
  });
});

describe("barge-in", () => {
  it("mutes playback, clears server audio, and cuts the transcript to what was heard", () => {
    vi.useFakeTimers();
    const { c, msgs, sent, ev } = harness();
    c.audioEl = { muted: false } as HTMLAudioElement;
    responding(c, "Your refund of one hundred dollars is approved today");
    c.speaking = true;
    c.playingResponseId = "r1";
    const resp = c.responses.get("r1")!;
    resp.audioStart = performance.now() - 1000;
    resp.itemId = "item1";
    void ev({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(c.audioEl.muted).toBe(true);
    expect(sent.map((s) => s.type)).toContain("output_audio_buffer.clear");
    expect(resp.interrupted).toBe(true);
    expect(msgs.get("va-r1")).toMatchObject({ interrupted: true, streaming: false });
    expect(msgs.get("va-r1")!.text.endsWith("…")).toBe(true);
    // No server truncation within the wait: the client truncates the model's history itself.
    vi.advanceTimersByTime(700);
    expect(sent.find((s) => s.type === "conversation.item.truncate")).toMatchObject({ item_id: "item1", content_index: 0 });
    vi.useRealTimers();
  });

  it("does nothing when the agent is silent and has no text yet", () => {
    const { c, sent, ev } = harness();
    responding(c, "");
    void ev({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(sent).toEqual([]);
    expect(c.responses.get("r1")!.interrupted).toBe(false);
  });
});

describe("tool bridge", () => {
  it("runs each call once even when both the arguments event and response.done report it", async () => {
    const { c, sent, posts, ev } = harness();
    responding(c, "");
    await ev({ type: "response.function_call_arguments.done", call_id: "call1", name: "get_policy", arguments: "{}", response_id: "r1" });
    await ev({
      type: "response.done",
      response: { id: "r1", status: "completed", output: [{ type: "function_call", call_id: "call1", name: "get_policy", arguments: "{}" }] },
    });
    expect(posts.filter((p) => p.url === "/api/voice/tool")).toHaveLength(1);
    expect(sent.map((s) => s.type)).toEqual(["conversation.item.create", "response.create"]);
    expect(sent[0]).toMatchObject({ item: { type: "function_call_output", call_id: "call1" } });
  });

  it("drops a call from an interrupted response (its arguments may be half-streamed)", async () => {
    const { c, posts, sent, ev } = harness();
    responding(c, "");
    c.responses.get("r1")!.interrupted = true;
    await ev({ type: "response.function_call_arguments.done", call_id: "call2", name: "issue_refund", arguments: "{", response_id: "r1" });
    await ev({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    expect(posts.filter((p) => p.url === "/api/voice/tool")).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it("shows a step indicator while the tool runs, and returns a retryable failure if the server is unreachable", async () => {
    const { c, msgs, deps } = harness();
    responding(c, "");
    const failingPost = (async () => null) as unknown as EventDeps["post"];
    startToolCall(c, { callId: "call3", name: "verify_identity", args: "{}", responseId: "r1" }, { ...deps, post: failingPost });
    expect(msgs.get("va-r1")!.steps).toHaveLength(1);
    const [out] = await Promise.all(c.responses.get("r1")!.calls);
    expect(JSON.parse(out.output)).toMatchObject({ ok: false, error: { code: "TOOL_FAILURE", retryable: true } });
  });
});

describe("server events", () => {
  it("benign cancel races are not shown as errors", async () => {
    const { deps, ev } = harness();
    await ev({ type: "error", error: { code: "response_cancel_not_active", message: "no active response" } });
    expect(deps.setError).not.toHaveBeenCalled();
    await ev({ type: "error", error: { code: "server_error", message: "boom" } });
    expect(deps.setError).toHaveBeenCalledWith("boom");
  });
});
