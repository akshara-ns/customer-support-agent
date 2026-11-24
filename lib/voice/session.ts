/**
 * Voice session setup: instructions (spoken style + the session's verified-account context),
 * recent history to replay, realtime tool definitions, and the ephemeral client secret.
 * The standard API key is used only here, server-side.
 */
import { MODELS, VOICE } from "@/lib/config";
import type { VoiceHistoryItem, VoiceSessionResponse } from "@/lib/contracts";
import { SYSTEM_PROMPT } from "@/lib/agent/prompt";
import type { EventStore, StoredEvent } from "@/lib/session/events";
import { deriveState } from "@/lib/session/events";
import { TOOL_DEFINITIONS } from "@/lib/tools/registry";
import type { ToolDeps } from "@/lib/tools/stores";
import { accountView } from "@/lib/tools/tools";

export const VOICE_STYLE = `You are on a live voice call.
- Speak naturally and briefly: one or two short sentences, then offer more detail if they want it.
- Before calling a tool, say a very short phrase such as "Let me check that." so there is no silence.
- Emails are spoken like "omar at example dot com": pass them to verify_identity in written form (omar@example.com). PINs are six digits.
- Say amounts naturally ("one hundred seventy-four dollars"). Don't spell out invoice ids unless asked.
- Only say a refund was issued or a ticket was created if the tool result in this call says so. If you're unsure, say what you will check instead.`;

/** Realtime function tools: same names, descriptions and schemas as chat. */
export const REALTIME_TOOLS = TOOL_DEFINITIONS.map((t) => ({
  type: "function" as const,
  name: t.function.name,
  description: t.function.description,
  parameters: t.function.parameters,
}));

export type HistoryItem = VoiceHistoryItem;

/** Last N visible messages from the session log (chat and voice). */
export function recentHistory(events: StoredEvent[], n: number = VOICE.historyMessages): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const { event, channel } of events) {
    if (event.type === "user_message" && event.text.trim()) items.push({ role: "user", text: event.text, channel });
    if (event.type === "assistant_message" && event.text.trim()) items.push({ role: "assistant", text: event.text, channel });
  }
  return items.slice(-n);
}

export async function buildVoiceInstructions(events: StoredEvent[], deps: ToolDeps): Promise<{ instructions: string; verified: boolean }> {
  const state = deriveState(events);
  let context = "Session context: the caller has NOT verified their identity in this conversation yet.";
  if (state.customer) {
    const user = deps.customers.get(state.customer.customerId);
    if (user) {
      const view = await accountView(user, deps, true);
      context =
        "Session context: the caller already verified their identity earlier in this conversation (possibly in text chat). " +
        "Do not ask for the email or PIN again. Their account (from verify_identity):\n" +
        JSON.stringify(view);
    }
  }
  if (state.failedVerifications >= 3) context += "\nVerification is locked for this conversation after 3 failed attempts.";
  return { instructions: `${SYSTEM_PROMPT}\n\n${VOICE_STYLE}\n\n${context}`, verified: !!state.customer };
}

export interface VoiceSessionConfig {
  type: "realtime";
  model: string;
  instructions: string;
  audio: {
    input: {
      transcription: { model: string };
      turn_detection: { type: "semantic_vad"; eagerness: "low" | "medium" | "high" | "auto"; create_response: boolean; interrupt_response: boolean };
    };
    output: { voice: string };
  };
  tools: typeof REALTIME_TOOLS;
  tool_choice: "auto";
  max_output_tokens: number;
}

export function voiceSessionConfig(instructions: string): VoiceSessionConfig {
  return {
    type: "realtime",
    model: MODELS.realtime,
    instructions,
    audio: {
      input: {
        transcription: { model: MODELS.realtimeTranscribe },
        // Semantic VAD: ends the turn when the caller has finished their thought, so pauses while reading out
        // an email or PIN don't cut them off (plain server VAD with 500 ms silence did). It still detects
        // speech start, auto-cancels an in-progress response (barge-in) and replies.
        turn_detection: { type: "semantic_vad", eagerness: "medium", create_response: true, interrupt_response: true },
      },
      output: { voice: VOICE.voice },
    },
    tools: REALTIME_TOOLS,
    tool_choice: "auto",
    // Server-enforced cap per response (the Realtime API has no session-duration setting to back the
    // 3-minute browser cap; this, the key TTL and the per-IP/daily session caps bound the cost).
    max_output_tokens: VOICE.maxOutputTokens,
  };
}

export type SecretMinter = (config: VoiceSessionConfig) => Promise<{ value: string; expiresAt: number }>;

/** POST /v1/realtime/client_secrets with the server's API key; returns only the ephemeral key. */
export function openAISecretMinter(apiKey: string, fetchImpl: typeof fetch = fetch): SecretMinter {
  return async (config) => {
    const res = await fetchImpl("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: VOICE.clientSecretTtlSeconds }, session: config }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`client_secrets ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { value?: string; expires_at?: number };
    if (!data.value?.startsWith("ek_")) throw new Error("client_secrets returned no ephemeral key");
    return { value: data.value, expiresAt: data.expires_at ?? 0 };
  };
}

export type { VoiceSessionResponse } from "@/lib/contracts";

export async function createVoiceSession(
  sessionId: string,
  deps: { events: EventStore; tools: ToolDeps; mint: SecretMinter },
): Promise<VoiceSessionResponse> {
  await deps.events.ensureSession(sessionId);
  const events = await deps.events.list(sessionId);
  const { instructions, verified } = await buildVoiceInstructions(events, deps.tools);
  const secret = await deps.mint(voiceSessionConfig(instructions));
  return {
    clientSecret: secret.value,
    expiresAt: secret.expiresAt,
    model: MODELS.realtime,
    verified,
    history: recentHistory(events),
    maxSeconds: VOICE.maxSessionSeconds,
  };
}
