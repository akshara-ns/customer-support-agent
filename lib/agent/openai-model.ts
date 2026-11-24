import "server-only";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { MODELS } from "@/lib/config";
import { openai } from "@/lib/openai";
import { ModelError, type AgentModel, type ModelRequest, type ModelTurn } from "@/lib/agent/model";

/** OpenAI chat-completions adapter: streaming, one tool call per step, typed errors. */
export function openAIAgentModel(model: string = MODELS.agent): AgentModel {
  return {
    name: model,
    async complete(req: ModelRequest, onText): Promise<ModelTurn> {
      try {
        const stream = await openai().chat.completions.create({
          model,
          reasoning_effort: "none",
          stream: true,
          stream_options: { include_usage: true },
          parallel_tool_calls: false,
          tool_choice: req.toolChoice,
          tools: req.tools as ChatCompletionTool[],
          // System prompt and tools first and unchanging: a stable prefix for prompt caching.
          messages: [{ role: "system", content: req.system }, ...(req.messages as ChatCompletionMessageParam[])],
        });
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
        if (err instanceof OpenAI.RateLimitError) throw new ModelError("llm_rate_limited", "The language model is rate limited.");
        if (err instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError("llm_timeout", "The language model timed out.");
        if (err instanceof OpenAI.APIError || err instanceof OpenAI.APIConnectionError) {
          throw new ModelError("llm_unavailable", "The language model is unavailable.");
        }
        throw err;
      }
    },
  };
}
