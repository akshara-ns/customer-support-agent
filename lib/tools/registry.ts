/**
 * Tool definitions (for the model) and the executor (for the agent loop). The executor
 * validates input, enforces preconditions, and turns any exception into a typed error.
 */
import { z } from "zod";
import { log } from "@/lib/log";
import { createEscalationTicket, getPolicy, issueRefund, verifyIdentity, type VerifyEffects } from "@/lib/tools/tools";
import type { ToolDeps } from "@/lib/tools/stores";
import type { Ticket, TicketReason, ToolContext, ToolName, ToolResult } from "@/lib/tools/types";

const TICKET_REASONS = [
  "refund_over_limit",
  "refund_outside_window",
  "billing_error",
  "account_suspended",
  "low_confidence",
  "customer_request",
  "security",
  "privacy_request",
  "other",
] as const satisfies readonly TicketReason[];

const Inputs = {
  // Strict formats: a placeholder or malformed value is INVALID_INPUT and never counts as a failed attempt.
  verify_identity: z.object({ email: z.email().max(200), code: z.string().regex(/^\d{6}$/, "support PIN must be 6 digits") }),
  get_policy: z.object({ question: z.string().min(3).max(500) }),
  issue_refund: z.object({ invoice_id: z.string().min(1).max(40), amount_usd: z.number(), reason: z.string().min(1).max(300) }),
  create_escalation_ticket: z.object({ reason: z.enum(TICKET_REASONS), summary: z.string().min(5).max(1000) }),
} satisfies Record<ToolName, z.ZodType>;

export { TOOL_LABELS } from "@/lib/tools/labels";

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
        "Search Fernway's support policies and troubleshooting guides (filtered to the verified customer's tier). Use for any question about rules, limits, plans or how-to. Returns a grounded answer with citations, or needs_escalation when the knowledge base doesn't cover it.",
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
        "Issue a refund against one invoice of the verified customer. Policy (tier limit, refund window, contract status, one refund per invoice) is enforced by the system; a refusal comes back as an error with the reason.",
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

export interface ToolOutcome {
  /** "unknown_tool" when the model asked for a tool that doesn't exist. */
  name: ToolName | "unknown_tool";
  result: ToolResult<unknown>;
  effects: VerifyEffects;
}

export function isToolName(name: string): name is ToolName {
  return name in Inputs;
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
  const parsed = Inputs[name].safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { name, result: { ok: false, error: { code: "INVALID_INPUT", message: issues, retryable: true } }, effects: {} };
  }

  try {
    switch (name) {
      case "verify_identity": {
        const out = await verifyIdentity(parsed.data as z.infer<(typeof Inputs)["verify_identity"]>, ctx, deps);
        return { name, ...out };
      }
      case "get_policy":
        return { name, result: await getPolicy(parsed.data as z.infer<(typeof Inputs)["get_policy"]>, ctx, deps), effects: {} };
      case "issue_refund": {
        const result = await issueRefund(parsed.data as z.infer<(typeof Inputs)["issue_refund"]>, ctx, deps);
        return { name, result, effects: !result.ok && result.error.ticket ? { ticket: result.error.ticket } : {} };
      }
      case "create_escalation_ticket": {
        const result = await createEscalationTicket(parsed.data as z.infer<(typeof Inputs)["create_escalation_ticket"]>, ctx, deps);
        const ticket: Ticket | undefined = result.ok ? result.data : undefined;
        return { name, result, effects: ticket ? { ticket } : {} };
      }
    }
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
