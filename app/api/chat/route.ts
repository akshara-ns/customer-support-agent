import { after } from "next/server";
import { z } from "zod";
import { RATE_LIMITS } from "@/lib/config";
import { openAIAgentModel } from "@/lib/agent/openai-model";
import { runTurn } from "@/lib/agent/run";
import { FAULTS, runWithFault } from "@/lib/faults";
import { authorizeSession, ownerFromRequest, withOwnerCookie } from "@/lib/session/owner";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { persistTrace } from "@/lib/observability/pg-traces";
import { consumeLimits, rateLimitedResponse } from "@/lib/ratelimit";
import { pgEventStore } from "@/lib/session/pg-store";
import { StreamLog } from "@/lib/session/stream-log";
import { productionToolDeps } from "@/lib/voice/deps";
import type { AgentEvent, SseEvent } from "@/lib/types";

export const maxDuration = 60;

const Body = z.object({
  sessionId: z.uuid(),
  message: z.string().trim().min(1).max(2000),
  /** Demo failure simulation for this one turn. */
  simulate: z.enum(FAULTS).optional(),
});

/**
 * POST /api/chat → text/event-stream of numbered, typed events (see AgentEvent in lib/types.ts).
 * Errors inside the turn become `error` events plus a graceful reply; the stream always ends with `done`.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Expected { sessionId: uuid, message: string (1-2000 chars) }.", requestId);
  }
  const { sessionId, message, simulate } = parsed.data;
  const owner = ownerFromRequest(request);
  try {
    const limit = await consumeLimits(request, [...RATE_LIMITS.chat]);
    if (!limit.allowed) return rateLimitedResponse(limit);
    if (!(await authorizeSession(sessionId, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
  } catch (err) {
    log.error("rate limit check failed", { requestId, sessionId }, err);
    return errorResponse(503, "unavailable", "Service temporarily unavailable.", requestId);
  }

  const encoder = new TextEncoder();
  // Every numbered event also goes to the stream log, so a dropped client can resume from its last seq.
  const streamId = crypto.randomUUID();
  const streamLog = new StreamLog(streamId, sessionId);
  let resolveTurn: () => void = () => {};
  // Keep the function alive until the turn finishes, even if the client disconnects mid-stream.
  after(() => new Promise<void>((r) => (resolveTurn = r)));
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let seq = 0;
      let closed = false;
      const send = (e: AgentEvent) => {
        const numbered: SseEvent = { ...e, seq: ++seq };
        streamLog.push(numbered);
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`id: ${seq}\nevent: ${e.type}\ndata: ${JSON.stringify(numbered)}\n\n`));
        } catch {
          closed = true; // client went away; the turn still finishes and is logged
        }
      };
      const t0 = Date.now();
      try {
        const summary = await runWithFault(simulate, () =>
          runTurn(
            { sessionId, message, channel: "chat" },
            {
              model: openAIAgentModel(),
              events: pgEventStore,
              tools: productionToolDeps(),
              traceSink: (trace, channel) => persistTrace(sessionId, trace, channel),
            },
            send,
          ),
        );
        log.info("chat turn", { requestId, sessionId, turnId: summary.turnId, state: summary.state, tools: summary.toolsCalled, ms: Date.now() - t0, simulate });
      } catch (err) {
        // runTurn handles model and tool failures itself; this is the last resort (e.g. DB down).
        log.error("chat turn crashed", { requestId, sessionId, simulate }, err);
        send({ type: "error", code: "internal", message: "Something went wrong on our side. Please try again.", retryable: true });
        send({ type: "done", turnId: "", state: "failed", totals: { durationMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } });
      } finally {
        await streamLog.close();
        if (!closed) controller.close();
        resolveTurn();
      }
    },
    cancel() {
      // Client went away; the turn keeps running (see after() above) and stays resumable.
    },
  });

  return withOwnerCookie(new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "x-request-id": requestId,
      "x-stream-id": streamId,
    },
  }), owner);
}

/** GET /api/chat?sessionId=… → the visible transcript (user/assistant messages, tickets) for reloads. */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const id = z.uuid().safeParse(new URL(request.url).searchParams.get("sessionId"));
  if (!id.success) return errorResponse(400, "invalid_request", "sessionId must be a UUID.", requestId);
  const owner = ownerFromRequest(request);
  try {
    if (!(await authorizeSession(id.data, owner))) return errorResponse(403, "forbidden", "This conversation belongs to another browser.", requestId);
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
    return withOwnerCookie(Response.json({ sessionId: id.data, transcript }, { headers: { "Cache-Control": "no-store", "x-request-id": requestId } }), owner);
  } catch (err) {
    log.error("transcript failed", { requestId, sessionId: id.data }, err);
    return errorResponse(503, "unavailable", "Transcript temporarily unavailable.", requestId);
  }
}
