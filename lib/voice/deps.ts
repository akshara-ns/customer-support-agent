import "server-only";
import { pgEventStore } from "@/lib/session/pg-store";
import { customerDirectory } from "@/lib/tools/customers";
import { guardedPolicySearch, pgLedger, pgTickets } from "@/lib/tools/pg-stores";
import type { ToolDeps } from "@/lib/tools/stores";

/** Production tool dependencies: the same ones /api/chat uses. */
export function productionToolDeps(now = new Date()): ToolDeps {
  return { customers: customerDirectory(now), ledger: pgLedger, tickets: pgTickets, policy: guardedPolicySearch, now: () => now };
}

export const productionEvents = pgEventStore;
