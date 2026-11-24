/**
 * Failure simulation for the live demo. A request may ask for ONE fault for its own turn; the
 * fault is injected at the real boundary (OpenAI client, tool, retrieval), so the real error
 * handling runs. Scoped with AsyncLocalStorage, so nothing leaks between requests.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const FAULTS = ["llm_timeout", "llm_rate_limit", "tool_failure", "retrieval_down"] as const;
export type Fault = (typeof FAULTS)[number];

const store = new AsyncLocalStorage<{ fault: Fault | null }>();

export function runWithFault<T>(fault: Fault | null | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ fault: fault ?? null }, fn);
}

export function activeFault(): Fault | null {
  return store.getStore()?.fault ?? null;
}
