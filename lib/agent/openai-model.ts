import "server-only";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { GUARDRAILS, MODELS } from "@/lib/config";
import { serverEnv } from "@/lib/env";
import { activeFault } from "@/lib/faults";
import { openai } from "@/lib/openai";
import { ModelError, type AgentModel, type ModelRequest, type ModelTurn } from "@/lib/agent/model";

function retryAfterMs(err: unknown): number | undefined {
  const h = (err as { headers?: Headers | Record<string, string> }).headers;
  const get = (k: string) => (h instanceof Headers ? h.get(k) : h?.[k]) ?? null;
  const ms = Number(get("retry-after-ms"));
  if (ms > 0) return ms;
  const s = Number(get("retry-after"));
  return s > 0 ? s * 1000 : undefined;
}

/**
 * Simulated 429: a fetch that returns a real HTTP 429 (with Retry-After) for the first two calls,
 * so the SDK raises a genuine RateLimitError and our retry path runs end to end.
 */
function rateLimitedClient(): OpenAI {
  return new OpenAI({
    apiKey: serverEnv().OPENAI_API_KEY ?? "missing",
    maxRetries: 0,
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached (simulated)", type: "requests", code: "rate_limit_exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1" },
      }),
  });
}

/** OpenAI chat-completions adapter: streaming, one tool call per step, typed errors, per-call timeout. */
export function openAIAgentModel(model: string = MODELS.agent): AgentModel {
  let simulated429s = 0;
  return {
    name: model,
    async complete(req: ModelRequest, onText): Promise<ModelTurn> {
      const fault = activeFault();
      const client = fault === "llm_rate_limit" && simulated429s++ < 2 ? rateLimitedClient() : openai();
      // Our retry loop (lib/agent/retry.ts) handles retries visibly, so the SDK's own retries are off here.
      const options = { maxRetries: 0, timeout: fault === "llm_timeout" ? 1 : GUARDRAILS.llmTimeoutMs };
      try {
        const stream = await client.chat.completions.create({
          model,
          reasoning_effort: "none",
          stream: true,
          stream_options: { include_usage: true },
          parallel_tool_calls: false,
          tool_choice: req.toolChoice,
          tools: req.tools as ChatCompletionTool[],
          // System prompt and tools first and unchanging: a stable prefix for prompt caching.
          messages: [{ role: "system", content: req.system }, ...(req.messages as ChatCompletionMessageParam[])],
        }, options);
        let content = "";
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        let usage: ModelTurn["usage"] = { model, tokensIn: 0, tokensOut: 0, cachedTokens: 0 };
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            onText(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            calls.set(tc.index, cur);
          }
          if (chunk.usage) {
            usage = {
              model,
              tokensIn: chunk.usage.prompt_tokens,
              tokensOut: chunk.usage.completion_tokens,
              cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            };
          }
        }
        return { content, toolCalls: [...calls.values()].filter((c) => c.name), usage };
      } catch (err) {
        if (err instanceof OpenAI.RateLimitError) throw new ModelError("llm_rate_limited", "The language model is rate limited.", retryAfterMs(err));
        if (err instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError("llm_timeout", "The language model timed out.");
        if (err instanceof OpenAI.InternalServerError || err instanceof OpenAI.APIConnectionError) {
          throw new ModelError("llm_unavailable", "The language model is unavailable.", retryAfterMs(err));
        }
        throw err;
      }
    },
  };
}
