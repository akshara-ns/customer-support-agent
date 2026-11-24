import "server-only";
/**
 * Second layer of the action-claim check: a small model extracts every action the reply says was done
 * (refund / ticket, with amount, invoice, ticket number); code compares them with the session's tool log. The regex gate
 * (claims.ts) stays the first layer; this catches paraphrases it misses ("Your refund is complete").
 * A different, cheaper model than the one that wrote the reply (`gpt-5.4-nano` vs `gpt-5.4-mini`).
 */
import { z } from "zod";
import { MODELS } from "@/lib/config";
import type { ActionChecker, TurnActions } from "@/lib/guardrails/claims";
import { openai } from "@/lib/openai";
import { estimateCostUsd } from "@/lib/observability/trace";

const Extracted = z.object({
  claims: z.array(
    z.object({
      quote: z.string(),
      action: z.enum(["refund", "ticket"]),
      amount_usd: z.number().nullable(),
      invoice_id: z.string().nullable(),
      ticket_number: z.string().nullable(),
    }),
  ),
});
export type ExtractedClaim = z.infer<typeof Extracted>["claims"][number];
export interface FalseClaim {
  quote: string;
  claimed_action: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "action", "amount_usd", "invoice_id", "ticket_number"],
        properties: {
          quote: { type: "string" },
          action: { type: "string", enum: ["refund", "ticket"] },
          amount_usd: { type: ["number", "null"] },
          invoice_id: { type: ["string", "null"] },
          ticket_number: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

/** The model only extracts claims; whether each is true is decided in code against the action log. */
const SYSTEM = `Extract every statement in a customer-support reply that says or implies an action WAS completed for this customer:
- refund: a refund issued, processed, approved, complete, sent, on its way, or money credited/returned to the customer;
- ticket: a ticket or escalation created, opened, or the case handed/escalated to a team.
For each, give the exact quote and any amount in USD, invoice id (like inv_2004) or ticket number (like ESC-1007) it mentions, else null.
Do NOT extract: statements that something was not done or can't be done; offers, questions or conditional/future steps ("I can escalate this if you'd like", "once billing reviews it"); general facts about how refunds work ("refunds arrive in 5-10 business days").
Return JSON only.`;

/** Compares extracted claims with what the tools actually did. */
export function falseClaims(claims: ExtractedClaim[], a: TurnActions): FalseClaim[] {
  const out: FalseClaim[] = [];
  for (const c of claims) {
    if (c.action === "refund") {
      const match = a.refunds.some(
        (r) => (c.amount_usd === null || Math.abs(r.amountUsd - c.amount_usd) < 0.005) && (c.invoice_id === null || r.invoiceId === c.invoice_id),
      );
      if (!match) out.push({ quote: c.quote, claimed_action: `refund${c.amount_usd !== null ? ` $${c.amount_usd}` : ""}${c.invoice_id ? ` on ${c.invoice_id}` : ""} not issued` });
    } else {
      const match = c.ticket_number === null ? a.tickets.length > 0 : a.tickets.some((t) => t.ticketNumber === c.ticket_number);
      if (!match) out.push({ quote: c.quote, claimed_action: `ticket${c.ticket_number ? ` ${c.ticket_number}` : ""} not created` });
    }
  }
  return out;
}

export interface ActionClaimCheck {
  claims: ExtractedClaim[];
  falseClaims: FalseClaim[];
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ms: number;
}

export async function checkActionClaims(reply: string, actions: TurnActions, model: string = MODELS.groundingCheck): Promise<ActionClaimCheck> {
  return extract(reply, actions, model);
}

/** Satisfies the gate's ActionChecker type. */
export const modelActionChecker: ActionChecker = (reply, actions) => checkActionClaims(reply, actions);

async function extract(reply: string, actions: TurnActions, model: string): Promise<ActionClaimCheck> {
  const t0 = performance.now();
  const res = await openai().chat.completions.create({
    model,
    reasoning_effort: "none",
    response_format: { type: "json_schema", json_schema: { name: "action_claims", strict: true, schema: SCHEMA } },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `<reply>\n${reply}\n</reply>` },
    ],
  });
  const tokensIn = res.usage?.prompt_tokens ?? 0;
  const tokensOut = res.usage?.completion_tokens ?? 0;
  const { claims } = Extracted.parse(JSON.parse(res.choices[0]?.message.content ?? "{}"));
  return {
    claims,
    falseClaims: falseClaims(claims, actions),
    model,
    tokensIn,
    tokensOut,
    costUsd: estimateCostUsd({ model, tokensIn, tokensOut }),
    ms: Math.round(performance.now() - t0),
  };
}
