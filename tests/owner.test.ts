import { describe, expect, it } from "vitest";
import { OWNER_COOKIE, ownerFromRequest, ownsSession } from "@/lib/session/owner";

const req = (cookie?: string, url = "https://app.example/api/chat") => new Request(url, { headers: cookie ? { cookie } : {} });

describe("session ownership (S1)", () => {
  it("issues an HttpOnly, Secure, SameSite owner cookie when the browser has none", () => {
    const o = ownerFromRequest(req());
    expect(o.setCookie).toMatch(new RegExp(`^${OWNER_COOKIE}=[A-Za-z0-9_-]{40,}; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`));
    expect(o.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses an existing token (same hash, no new cookie) and ignores malformed ones", () => {
    const token = "a".repeat(43);
    const a = ownerFromRequest(req(`other=1; ${OWNER_COOKIE}=${token}`));
    const b = ownerFromRequest(req(`${OWNER_COOKIE}=${token}`));
    expect(a.setCookie).toBeNull();
    expect(a.hash).toBe(b.hash);
    expect(ownerFromRequest(req(`${OWNER_COOKIE}=short`)).setCookie).not.toBeNull();
  });

  it("claims an unowned session; an owned one only matches its owner", () => {
    expect(ownsSession(null, "h1")).toBe(true);
    expect(ownsSession("h1", "h1")).toBe(true);
    expect(ownsSession("h1", "h2")).toBe(false);
  });
});
