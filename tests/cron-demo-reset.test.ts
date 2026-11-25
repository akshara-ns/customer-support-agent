/** The daily demo-reset route runs only for Vercel's cron call (Authorization: Bearer $CRON_SECRET). */
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "cron-secret-for-tests-0123456789";

afterEach(() => {
  vi.doUnmock("@/lib/db/demo-reset");
  vi.doUnmock("@/lib/db/client");
  vi.doUnmock("next/server");
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function route(secret: string | undefined = SECRET) {
  vi.resetModules();
  if (secret === undefined) vi.stubEnv("CRON_SECRET", "");
  else vi.stubEnv("CRON_SECRET", secret);
  const reset = vi.fn(async () => ({ ledgerEntries: 2, tickets: 1 }));
  vi.doMock("@/lib/db/demo-reset", () => ({ resetDemoData: reset }));
  vi.doMock("@/lib/db/client", () => ({ db: () => ({}) }));
  vi.doMock("next/server", () => ({ connection: async () => {} }));
  const { GET } = await import("@/app/api/cron/demo-reset/route");
  return { GET, reset };
}
const call = (auth?: string) => new Request("http://x/api/cron/demo-reset", { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/demo-reset", () => {
  it("rejects a call without the secret, or with a wrong one, and resets nothing", async () => {
    const { GET, reset } = await route();
    expect((await GET(call())).status).toBe(401);
    expect((await GET(call("Bearer wrong-secret-0123456789"))).status).toBe(401);
    expect((await GET(call(SECRET))).status).toBe(401); // missing "Bearer "
    expect(reset).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET isn't configured", async () => {
    const { GET, reset } = await route(undefined);
    expect((await GET(call("Bearer "))).status).toBe(401);
    expect(reset).not.toHaveBeenCalled();
  });

  it("resets with Vercel's cron header", async () => {
    const { GET, reset } = await route();
    const res = await GET(call(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ledgerEntries: 2, tickets: 1 });
    expect(reset).toHaveBeenCalledOnce();
  });
});
