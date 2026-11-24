/**
 * Tool bridge: a function call from the Realtime model runs on the server (/api/voice/tool, the same
 * executor and policy checks as chat). The step indicator is shown while it runs; the output goes back
 * to the model once the response is done.
 */
import { applyAgentEvent } from "@/components/agentEvents";
import { voiceMsg } from "@/components/voice/transcript";
import type { Note, Post, Upsert, VoiceRuntime } from "@/components/voice/types";
import { toolLabel, type VoiceToolResponse } from "@/lib/contracts";

/** Output for a call from an interrupted or cancelled response: never run, but always answered. */
export const CANCELLED_OUTPUT = JSON.stringify({
  ok: false,
  error: { code: "CANCELLED", message: "The caller interrupted, so this step was not run. Nothing was changed.", retryable: true },
});

/** What the model receives if the server can't be reached. */
const UNREACHABLE_OUTPUT = JSON.stringify({
  ok: false,
  error: { code: "TOOL_FAILURE", message: "The system couldn't complete this step.", retryable: true },
});

export interface ToolCall {
  callId: string;
  name: string;
  args: string;
  responseId: string;
}

export function startToolCall(
  c: VoiceRuntime,
  call: ToolCall,
  deps: { post: Post; sessionId: string | null; upsert: Upsert; note: Note; takeFault?: () => string | null },
): void {
  const { callId, name, args, responseId } = call;
  const { post, sessionId, upsert, note, takeFault } = deps;
  if (c.handledCalls.has(callId)) return;
  c.handledCalls.add(callId);
  const resp = c.responses.get(responseId);
  // A call from an interrupted/cancelled response may have half-streamed arguments: don't run it, but
  // still answer it so the conversation never holds a call without an output.
  if (resp?.interrupted) {
    note("note", `tool ${name} cancelled (response interrupted)`);
    resp.calls.push(Promise.resolve({ callId, output: CANCELLED_OUTPUT }));
    return;
  }
  const turnId = resp?.turnId ?? c.turnId;
  const msgId = resp?.msgId ?? `va-${responseId}`;
  const stepId = `${turnId}:${callId}`;
  upsert(msgId, voiceMsg(msgId, "assistant"), (m) =>
    applyAgentEvent(m, { type: "step_started", stepId, tool: name, label: toolLabel(name) }),
  );
  note("note", `tool → ${name}`);
  const simulate = takeFault?.() ?? undefined;
  const p = post<VoiceToolResponse>("/api/voice/tool", { sessionId, turnId, callId, name, arguments: args, simulate }).then((res) => {
    for (const e of res?.events ?? []) upsert(msgId, voiceMsg(msgId, "assistant"), (m) => applyAgentEvent(m, e));
    const output = res?.output ?? UNREACHABLE_OUTPUT;
    note("note", `tool ← ${name}`, output.slice(0, 160));
    return { callId, output };
  });
  resp?.calls.push(p);
}
