/**
 * Failure simulation for the live demo. A request may ask for ONE fault for its own turn; the
 * fault is injected at the real boundary (OpenAI client, tool, retrieval), so the real error
 * handling runs. Scoped with AsyncLocalStorage, so nothing leaks between requests.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Fault } from "@/lib/contracts";
export { FAULTS, type Fault } from "@/lib/contracts";

const store = new AsyncLocalStorage<{ fault: Fault | null }>();

export function runWithFault<T>(fault: Fault | null | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ fault: fault ?? null }, fn);
}

export function activeFault(): Fault | null {
  return store.getStore()?.fault ?? null;
}
