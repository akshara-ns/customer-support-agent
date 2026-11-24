import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { openAIAgentModel } from "@/lib/agent/openai-model";
import { runTurn } from "@/lib/agent/run";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { pgEventStore } from "@/lib/session/pg-store";
import { customerDirectory } from "@/lib/tools/customers";
import { guardedPolicySearch, pgLedger, pgTickets } from "@/lib/tools/pg-stores";
import type { AgentEvent, SseEvent } from "@/lib/types";

export const maxDuration = 60;

const Body = z.object({
  sessionId: z.uuid(),
  message: z.string().trim().min(1).max(2000),
});

/**
 * POST /api/chat → text/event-stream of numbered, typed events (see AgentEvent in lib/types.ts).
 * Errors inside the turn become `error` events plus a graceful reply; the stream always ends with `done`.
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_request", message: "Expected { sessionId: uuid, message: string }." }, { status: 400 });
  }
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.chat]);
    if (!limit.allowed) return rateLimitedResponse(limit);
  } catch (err) {
    console.error("rate limit check failed", err);
    return Response.json({ error: "unavailable", message: "Service temporarily unavailable." }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      const send = (e: AgentEvent) => {
        const numbered: SseEvent = { ...e, seq: ++seq };
        controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(numbered)}\n\n`));
      };
      try {
        const now = new Date();
        await runTurn(
          { sessionId: parsed.data.sessionId, message: parsed.data.message, channel: "chat" },
          {
            model: openAIAgentModel(),
            events: pgEventStore,
            tools: { customers: customerDirectory(now), ledger: pgLedger, tickets: pgTickets, policy: guardedPolicySearch, now: () => now },
          },
          send,
        );
      } catch (err) {
        // runTurn handles model and tool failures itself; this is the last resort (e.g. DB down).
        console.error("chat turn crashed", err);
        send({ type: "error", code: "internal", message: "Something went wrong on our side. Please try again.", retryable: true });
        send({ type: "done", turnId: "", state: "failed", totals: { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** GET /api/chat?sessionId=… → the visible transcript (user/assistant messages, tickets) for reloads. */
export async function GET(request: Request): Promise<Response> {
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("sessionId"));
  if (!id.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const events = await pgEventStore.list(id.data);
  type Line = { seq: number; channel: string; role: "user" | "assistant" | "ticket"; text: string; interrupted?: boolean };
  const transcript = events.flatMap(({ seq, channel, event }): Line[] => {
    if (event.type === "user_message") return [{ seq, channel, role: "user", text: event.text }];
    if (event.type === "assistant_message") return [{ seq, channel, role: "assistant", text: event.text, interrupted: event.interrupted }];
    if (event.type === "escalation" && event.ticket) {
      return [{ seq, channel, role: "ticket", text: `${event.ticket.ticketNumber} (${event.ticket.priority})` }];
    }
    return [];
  });
  return Response.json({ sessionId: id.data, transcript }, { headers: { "Cache-Control": "no-store" } });
}
