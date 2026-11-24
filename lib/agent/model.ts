/**
 * The model behind the agent loop, as a small port so scenario tests can script it.
 */
import type { ContextMessage } from "@/lib/session/events";

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelTurn {
  content: string;
  toolCalls: ModelToolCall[];
  usage: { model: string; tokensIn: number; tokensOut: number; cachedTokens: number };
}

export interface ModelRequest {
  system: string;
  messages: ContextMessage[];
  tools: readonly unknown[];
  /** "none" forces a final text reply (used when the step budget is spent). */
  toolChoice: "auto" | "none";
}

export interface AgentModel {
  readonly name: string;
  /** Streams text deltas through `onText` and resolves with the full turn. */
  complete(req: ModelRequest, onText: (delta: string) => void): Promise<ModelTurn>;
}

export class ModelError extends Error {
  constructor(
    readonly code: "llm_timeout" | "llm_rate_limited" | "llm_unavailable",
    message: string,
  ) {
    super(message);
  }
}
