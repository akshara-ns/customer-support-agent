/**
 * Agent turn state machine. Every transition is checked against this table and traced, so
 * an illegal path (e.g. responding while a tool is still running) fails loudly.
 */
export type AgentState =
  | "awaiting_input"
  | "planning"
  | "executing_tool"
  | "checking_claims"
  | "responding"
  | "escalated"
  | "completed"
  | "failed";

const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  awaiting_input: ["planning", "failed"],
  planning: ["executing_tool", "checking_claims", "failed"],
  executing_tool: ["planning", "failed"],
  checking_claims: ["responding", "failed"],
  responding: ["completed", "escalated", "failed"],
  escalated: [],
  completed: [],
  failed: [],
};

export interface Transition {
  from: AgentState;
  to: AgentState;
  at: number;
  note?: string;
}

export class AgentMachine {
  private current: AgentState = "awaiting_input";
  readonly history: Transition[] = [];

  get state(): AgentState {
    return this.current;
  }

  to(next: AgentState, note?: string): void {
    if (!TRANSITIONS[this.current].includes(next)) {
      throw new Error(`illegal agent transition ${this.current} → ${next}`);
    }
    this.history.push({ from: this.current, to: next, at: Date.now(), note });
    this.current = next;
  }

  /** Move to `failed` from any non-terminal state. */
  fail(note: string): void {
    if (TRANSITIONS[this.current].includes("failed")) this.to("failed", note);
  }
}
