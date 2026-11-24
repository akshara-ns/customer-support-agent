import "server-only";
import { MODELS } from "@/lib/config";
import { DATA_NOT_INSTRUCTIONS, renderDocuments } from "@/lib/rag/prompt";
import { openai } from "@/lib/openai";
import type { Trace } from "@/lib/observability/trace";
import type { RetrievedChunk, Tier } from "@/lib/types";

export const NOT_COVERED = "NOT_COVERED";

const SYSTEM = `You are a customer support assistant for Fernway Workspace.
Answer ONLY from the documents provided. ${DATA_NOT_INSTRUCTIONS}

Rules:
- Every sentence that states a fact must end with the id of the document that supports it, in square brackets, e.g. [refund-policy#3].
- Only cite document ids that appear in the documents. Never invent ids, numbers, limits or timeframes.
- If the documents do not contain the answer to the question, reply with exactly ${NOT_COVERED} and nothing else.
- Never approve, promise or confirm a refund or account change; you can only explain what the policy says.
- Be concise: at most 4 sentences.`;

export interface GeneratedAnswer {
  text: string;
  declined: boolean;
}

/** Generates a cited answer from retrieved chunks, or NOT_COVERED when they don't answer it. */
export async function generateAnswer(
  query: string,
  chunks: RetrievedChunk[],
  tier: Tier | undefined,
  trace?: Trace,
): Promise<GeneratedAnswer> {
  const user = `Customer tier: ${tier ?? "unknown"}\n\n<documents>\n${renderDocuments(chunks)}\n</documents>\n\nQuestion: ${query}`;
  const call = async (onUsage?: (tIn: number, tOut: number) => void): Promise<GeneratedAnswer> => {
    const res = await openai().chat.completions.create({
      model: MODELS.answer,
      reasoning_effort: "none",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    });
    onUsage?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0);
    const text = (res.choices[0]?.message.content ?? "").trim();
    return { text, declined: text === "" || text.includes(NOT_COVERED) };
  };
  if (!trace) return call();
  return trace.span("llm", "generate_answer", { model: MODELS.answer, query }, async (s) => {
    const out = await call((tokensIn, tokensOut) => s.usage({ model: MODELS.answer, tokensIn, tokensOut }));
    s.output(out);
    return out;
  });
}
