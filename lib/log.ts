/**
 * Structured server logs: one JSON line per event with request and session ids. Error stacks go
 * to the server log only, never to the client.
 */
type Fields = Record<string, unknown> & { requestId?: string; sessionId?: string };

function write(level: "info" | "warn" | "error", msg: string, fields: Fields = {}, err?: unknown): void {
  const line: Record<string, unknown> = { level, msg, time: new Date().toISOString(), ...fields };
  if (err !== undefined) {
    line.error = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && err.stack) line.stack = err.stack.split("\n").slice(0, 6).join(" | ");
  }
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const log = {
  info: (msg: string, f?: Fields) => write("info", msg, f),
  warn: (msg: string, f?: Fields, err?: unknown) => write("warn", msg, f, err),
  error: (msg: string, f?: Fields, err?: unknown) => write("error", msg, f, err),
};

/** Consistent typed error body for every API route; includes the request id, never a stack. */
export function errorResponse(status: number, error: string, message: string, requestId: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error, message, requestId }, { status, headers: { "x-request-id": requestId, "Cache-Control": "no-store", ...headers } });
}

export function newRequestId(request: Request): string {
  return request.headers.get("x-vercel-id")?.split("::").pop() || crypto.randomUUID();
}
