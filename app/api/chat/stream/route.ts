import { z } from "zod";
import { errorResponse, log, newRequestId } from "@/lib/log";
import { readStreamEvents } from "@/lib/session/stream-log";

export const maxDuration = 60;

const Query = z.object({ streamId: z.uuid(), after: z.coerce.number().int().min(0).max(100_000) });

/**
 * GET /api/chat/stream?streamId=…&after=N: resume a dropped chat stream. Replays every event with
 * seq > N from the stream log, then follows new events until `done` (or ~50 s; resume again after).
 * The client ignores any seq it already has, so there are no duplicates and no gaps.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId(request);
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return errorResponse(400, "invalid_request", "Expected streamId (uuid) and after (integer).", requestId);
  const { streamId } = parsed.data;
  let last = parsed.data.after;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const deadline = Date.now() + 50_000;
      try {
        for (;;) {
          const events = await readStreamEvents(streamId, last);
          let finished = false;
          for (const e of events) {
            controller.enqueue(encoder.encode(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
            last = e.seq;
            if (e.type === "done") finished = true;
          }
          if (finished || Date.now() > deadline || request.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (err) {
        log.error("stream resume failed", { requestId, streamId }, err);
      } finally {
        controller.close();
      }
    },
  });
  log.info("stream resume", { requestId, streamId, after: parsed.data.after });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "x-request-id": requestId },
  });
}
