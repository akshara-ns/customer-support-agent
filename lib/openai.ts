import "server-only";
import OpenAI from "openai";
import { serverEnv } from "@/lib/env";
import { GUARDRAILS } from "@/lib/config";

let client: OpenAI | undefined;

/** Server-side OpenAI client. The key never leaves the server. */
export function openai(): OpenAI {
  if (client) return client;
  const key = serverEnv().OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  client = new OpenAI({ apiKey: key, timeout: GUARDRAILS.llmTimeoutMs, maxRetries: 2 });
  return client;
}
