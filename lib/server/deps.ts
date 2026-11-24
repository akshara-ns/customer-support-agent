import "server-only";
import { pgEventStore } from "@/lib/session/pg-store";
import { customerDirectory } from "@/lib/tools/customers";
import { guardedPolicySearch, pgLedger, pgTickets, pgVerifyGuard } from "@/lib/tools/pg-stores";
import type { ToolDeps } from "@/lib/tools/stores";

/** Production tool dependencies: the same ones /api/chat uses. */
export function productionToolDeps(now = new Date()): ToolDeps {
  return { customers: customerDirectory(now), ledger: pgLedger, tickets: pgTickets, policy: guardedPolicySearch, verifyGuard: pgVerifyGuard, now: () => now };
}

export const productionEvents = pgEventStore;

/** Layer-2 action-claim check (gpt-5.4-nano extraction vs the tool log), used by chat and voice. */
export { modelActionChecker as productionActionChecker } from "@/lib/guardrails/action-claims";

/** Demo accounts for the public panel (server-rendered on the home page). */
export { demoUsers } from "@/lib/tools/customers";
