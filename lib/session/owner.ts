import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";

/**
 * Session ownership. Each browser gets a random owner token in an HttpOnly cookie; a session is bound
 * to the hash of the first token that uses it, and every session-scoped route checks the binding.
 * The session UUID alone is no longer enough to read or act on a conversation.
 */
export const OWNER_COOKIE = "fw_owner";

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export interface Owner {
  hash: string;
  /** Set-Cookie value to send when the browser had no token yet. */
  setCookie: string | null;
}

export function ownerFromRequest(request: Request): Owner {
  const existing = readCookie(request, OWNER_COOKIE);
  const token = existing && /^[A-Za-z0-9_-]{32,}$/.test(existing) ? existing : randomBytes(32).toString("base64url");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    hash: createHash("sha256").update(token).digest("hex"),
    setCookie: existing === token ? null : `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
  };
}

/** Pure rule, unit-tested: an unowned session is claimed; an owned one must match. */
export function ownsSession(storedHash: string | null, callerHash: string): boolean {
  return storedHash === null || storedHash === callerHash;
}

/**
 * Creates the session if needed and claims it for this owner if unowned (atomically), then checks.
 * Returns false when another browser owns the session.
 */
export async function authorizeSession(sessionId: string, owner: Owner): Promise<boolean> {
  const rows = (await db()`
    INSERT INTO sessions (id, owner_hash) VALUES (${sessionId}, ${owner.hash})
    ON CONFLICT (id) DO UPDATE SET owner_hash = COALESCE(sessions.owner_hash, EXCLUDED.owner_hash)
    RETURNING owner_hash`) as { owner_hash: string | null }[];
  return ownsSession(rows[0]?.owner_hash ?? null, owner.hash) && rows[0]?.owner_hash === owner.hash;
}

/** The session a chat stream belongs to (for resume authorization). */
export async function sessionOfStream(streamId: string): Promise<string | null> {
  const rows = (await db()`SELECT session_id FROM stream_events WHERE stream_id = ${streamId} LIMIT 1`) as { session_id: string }[];
  return rows[0]?.session_id ?? null;
}

export function withOwnerCookie(res: Response, owner: Owner): Response {
  if (owner.setCookie) res.headers.append("Set-Cookie", owner.setCookie);
  return res;
}
