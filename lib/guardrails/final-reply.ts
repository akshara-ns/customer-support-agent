import "server-only";
/**
 * Grounds the agent's final reply (senior review): every factual statement the customer sees must be
 * backed by what our systems returned in this conversation: grounded get_policy answers (themselves
 * checked against the cited chunks), refund receipts and refusals, tickets, the verified account view.
 * A second model lists the reply's claims and whether those records state them; code decides what to do.
 */
import { z } from "zod";
import { MODELS } from "@/lib/config";
import { openai } from "@/lib/openai";
import { estimateCostUsd } from "@/lib/observability/trace";
import { DATA_NOT_INSTRUCTIONS } from "@/lib/rag/prompt";

export interface Fact {
  id: string;
  content: string;
}

const Result = z.object({ claims: z.array(z.object({ claim: z.string(), supported: z.boolean() })) });
export type FinalClaims = z.infer<typeof Result>["claims"];

export interface FinalReplyCheck {
  claims: FinalClaims;
  unsupported: string[];
  ok: boolean;
  usage?: { model: string; tokensIn: number; tokensOut: number; costUsd: number };
}

export type FinalReplyChecker = (reply: string, facts: Fact[]) => Promise<FinalReplyCheck>;

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
        required: ["claim", "supported"],
        properties: { claim: { type: "string" }, supported: { type: "boolean" } },
      },
    },
  },
} as const;

const SYSTEM = `You check a customer-support reply against the records our systems returned in this conversation.
${DATA_NOT_INSTRUCTIONS}

List each factual claim in the reply and whether the records state it (same numbers, limits, timeframes, invoices, ticket numbers, outcomes).
NOT claims (don't list them): greetings; questions; requests for the customer's email or PIN; saying you can't help or can't answer; offers to check, refund, escalate or hand the case to a person.
ARE claims: policy or product facts, account facts, statements that something was done, and any advice or general-knowledge statement. An offer to help with something outside this company's support (investing, taxes, other companies' products) is a claim and is NOT supported.
A claim is supported only if a record states it. Return JSON only.`;

const render = (facts: Fact[]) => facts.map((f) => `<record id="${f.id}">\n${f.content.replace(/</g, "&lt;")}\n</record>`).join("\n\n");

export const checkFinalReply: FinalReplyChecker = async (reply, facts) => {
  const model = MODELS.groundingCheck;
  const res = await openai().chat.completions.create({
    model,
    reasoning_effort: "none",
    response_format: { type: "json_schema", json_schema: { name: "final_reply_check", strict: true, schema: SCHEMA } },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `<records>\n${render(facts) || "(none)"}\n</records>\n\n<reply>\n${reply}\n</reply>` },
    ],
  });
  const { claims } = Result.parse(JSON.parse(res.choices[0]?.message.content ?? "{}"));
  const tokensIn = res.usage?.prompt_tokens ?? 0;
  const tokensOut = res.usage?.completion_tokens ?? 0;
  const unsupported = claims.filter((c) => !c.supported).map((c) => c.claim);
  return { claims, unsupported, ok: unsupported.length === 0, usage: { model, tokensIn, tokensOut, costUsd: estimateCostUsd({ model, tokensIn, tokensOut }) } };
};
