/**
 * Tool definitions (for the model) and the executor (for the agent loop). The executor
 * validates input, enforces preconditions, and turns any exception into a typed error.
 */
import { z } from "zod";
import { log } from "@/lib/log";
import { TICKET_REASONS, TOOL_NAMES, type ToolEffects, type ToolName, type ToolOutcome, type ToolOutputs, type ToolResult } from "@/lib/contracts";
import { createEscalationTicket, getPolicy, issueRefund, verifyIdentity } from "@/lib/tools/tools";
import type { ToolDeps } from "@/lib/tools/stores";
import type { ToolContext } from "@/lib/tools/types";

const Inputs = {
  // Strict formats: a placeholder or malformed value is INVALID_INPUT and never counts as a failed attempt.
  verify_identity: z.object({ email: z.email().max(200), code: z.string().regex(/^\d{6}$/, "support PIN must be 6 digits") }),
  get_policy: z.object({ question: z.string().min(3).max(500) }),
  issue_refund: z.object({ invoice_id: z.string().min(1).max(40), amount_usd: z.number(), reason: z.string().min(1).max(300) }),
  create_escalation_ticket: z.object({ reason: z.enum(TICKET_REASONS), summary: z.string().min(5).max(1000) }),
} satisfies Record<ToolName, z.ZodType>;

export { TOOL_LABELS } from "@/lib/contracts";

/** OpenAI function definitions. Order and text are fixed so the prompt prefix stays cacheable. */
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "verify_identity",
      description:
        "Verify the customer with the email on file and their 6-digit support PIN. Required before discussing or changing anything on an account. Returns tier, contract status and invoices.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["email", "code"],
        properties: {
          email: { type: "string", description: "Email address on the account" },
          code: { type: "string", description: "6-digit support PIN" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_policy",
      description:
        "Search Fernway's support policies and troubleshooting guides (filtered to the verified customer's tier). Use for questions about rules, limits, plans or how-to. Not for deciding a refund request: call issue_refund, which applies the policy. Returns a grounded answer with citations, or needs_escalation when the knowledge base doesn't cover it.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: { question: { type: "string", description: "The customer's question, self-contained" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_refund",
      description:
        "Issue a refund against one invoice of the verified customer. Policy (tier limit, refund window, contract status, one refund per invoice) is enforced by the system; a refusal comes back as an error with the reason. Call it for every refund request, including amounts you expect to be refused; don't refuse from policy text yourself.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["invoice_id", "amount_usd", "reason"],
        properties: {
          invoice_id: { type: "string" },
          amount_usd: { type: "number", description: "Amount in USD, e.g. 174 or 12.50" },
          reason: { type: "string", description: "Short reason given by the customer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_escalation_ticket",
      description:
        "Hand the case to a human team. Use when the customer asks for a human or agrees to escalate, or when a policy answer or refund says it needs escalation. Returns the ticket number and response target.",
      strict: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["reason", "summary"],
        properties: {
          reason: { type: "string", enum: [...TICKET_REASONS] },
          summary: { type: "string", description: "One paragraph: the problem, what the customer wants, steps taken" },
        },
      },
    },
  },
] as const;

export type { ToolOutcome } from "@/lib/contracts";

type ToolInput<K extends ToolName> = z.infer<(typeof Inputs)[K]>;
type Handler<K extends ToolName> = (
  args: ToolInput<K>,
  ctx: ToolContext,
  deps: ToolDeps,
) => Promise<{ result: ToolResult<ToolOutputs[K]>; effects: ToolEffects }>;

/** One handler per tool, typed end to end: input from its zod schema, output from ToolOutputs. */
const HANDLERS: { [K in ToolName]: Handler<K> } = {
  verify_identity: (a, c, d) => verifyIdentity(a, c, d),
  get_policy: async (a, c, d) => {
    const result = await getPolicy(a, c, d);
    const ticket = result.ok && result.data.status === "needs_escalation" ? result.data.ticket : undefined;
    return { result, effects: ticket ? { ticket } : {} };
  },
  issue_refund: async (a, c, d) => {
    const result = await issueRefund(a, c, d);
    return { result, effects: !result.ok && result.error.ticket ? { ticket: result.error.ticket } : {} };
  },
  create_escalation_ticket: async (a, c, d) => {
    const result = await createEscalationTicket(a, c, d);
    return { result, effects: result.ok ? { ticket: result.data } : {} };
  },
};

async function runHandler<K extends ToolName>(name: K, args: ToolInput<K>, ctx: ToolContext, deps: ToolDeps): Promise<ToolOutcome> {
  const out = await HANDLERS[name](args, ctx, deps);
  // TypeScript can't correlate a generic K with the union member; the handler map above guarantees it.
  return { name, ...out } as ToolOutcome;
}

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** Validates, runs, and never throws. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolContext, deps: ToolDeps): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return {
      name: "unknown_tool",
      result: { ok: false, error: { code: "INVALID_INPUT", message: `Unknown tool ${name}.`, retryable: false } },
      effects: {},
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return { name, result: { ok: false, error: { code: "INVALID_INPUT", message: "Arguments are not valid JSON.", retryable: true } }, effects: {} };
  }
  // Re-verifying the account this session already verified is a no-op (the model only ever sees
  // the PIN redacted in later turns), so let it through before the strict format check.
  if (name === "verify_identity" && ctx.customer) {
    const loose = z.object({ email: z.string(), code: z.string() }).safeParse(args);
    if (loose.success && deps.customers.findByEmail(loose.data.email)?.customerId === ctx.customer.customerId) {
      return { name, ...(await verifyIdentity(loose.data, ctx, deps)) };
    }
  }
  const parsed = Inputs[name].safeParse(args) as z.ZodSafeParseResult<ToolInput<typeof name>>;
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { name, result: { ok: false, error: { code: "INVALID_INPUT", message: issues, retryable: true } }, effects: {} };
  }

  try {
    return await runHandler(name, parsed.data, ctx, deps);
  } catch (err) {
    log.error("tool failed", { tool: name, sessionId: ctx.sessionId, turnId: ctx.turnId }, err);
    if (name === "get_policy") {
      return {
        name,
        result: { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "The knowledge base is temporarily unavailable.", retryable: true } },
        effects: {},
      };
    }
    const message =
      name === "issue_refund"
        ? "The refund didn't go through and nothing was refunded. It is safe to call issue_refund again with the same invoice and amount: the request is recorded, so a retry can never refund twice."
        : "The system couldn't complete this step. Nothing was changed.";
    return { name, result: { ok: false, error: { code: "TOOL_FAILURE", message, retryable: true } }, effects: {} };
  }
}

/** Removes secrets from tool arguments before they are logged or replayed to the model. */
export function redactArgs(name: string, rawArgs: string): string {
  if (name !== "verify_identity") return rawArgs;
  try {
    const a = JSON.parse(rawArgs) as { email?: string; code?: string };
    return JSON.stringify({ email: a.email, code: a.code ? "[redacted]" : undefined });
  } catch {
    return "{}";
  }
}
