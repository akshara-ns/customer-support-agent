import "server-only";
import OpenAI from "openai";
import { serverEnv } from "@/lib/env";
import { GUARDRAILS } from "@/lib/config";
import { turnSignal } from "@/lib/deadline";

/** Joins the SDK's per-call signal with the current turn's deadline signal (if any). */
const deadlineFetch: typeof fetch = (url, init) => {
  const turn = turnSignal();
  const signal = turn && init?.signal ? AbortSignal.any([init.signal, turn]) : (turn ?? init?.signal ?? undefined);
  return fetch(url, { ...init, signal });
};

let client: OpenAI | undefined;

/**
 * Server-side OpenAI client. The key never leaves the server. Short default timeout and no SDK retries:
 * our own retry layer (lib/agent/retry.ts) is the only one, and the turn deadline cancels in-flight calls.
 */
export function openai(): OpenAI {
  if (client) return client;
  const key = serverEnv().OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  client = new OpenAI({ apiKey: key, timeout: GUARDRAILS.toolCallTimeoutMs, maxRetries: 0, fetch: deadlineFetch });
  return client;
}
