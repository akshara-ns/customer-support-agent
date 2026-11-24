import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Admin access for debug views: the `x-admin-key` header must match the ADMIN_KEY server env var
 * (constant-time compare). With no ADMIN_KEY set, nobody is admin.
 */
export function isAdmin(request: Request): boolean {
  const key = process.env.ADMIN_KEY;
  const given = request.headers.get("x-admin-key");
  if (!key || key.length < 16 || !given) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(key), digest(given));
}
