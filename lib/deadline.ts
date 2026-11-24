/**
 * One end-to-end deadline per chat turn. The turn's AbortSignal is carried with AsyncLocalStorage
 * (like faults.ts). The shared OpenAI client's fetch joins it with the SDK's own signal, so every call
 * inside the turn (agent model, embeddings, answer, grounding, claim check) is cancelled when the
 * deadline passes, without threading a parameter through each layer. See lib/openai.ts.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export class DeadlineExceeded extends Error {
  constructor() {
    super("The turn ran past its time budget.");
    this.name = "DeadlineExceeded";
  }
}

const store = new AsyncLocalStorage<AbortSignal>();

export function runWithSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

export function turnSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Rejects with DeadlineExceeded as soon as the signal aborts, even if `p` ignores it (a slow DB call). */
export function raceDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineExceeded());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineExceeded());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
