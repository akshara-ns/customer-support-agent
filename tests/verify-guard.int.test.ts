/** Integration (live Neon): per-client and per-account failed-PIN counters. Throwaway email; cleans up. Skipped without DATABASE_URL. */
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db/client";
import { pgVerifyGuard } from "@/lib/tools/pg-stores";

const live = Boolean(process.env.DATABASE_URL);
const EMAIL = `guard-test-${Date.now()}@example.invalid`;
const key = createHash("sha256").update(EMAIL).digest("hex").slice(0, 32);

describe.skipIf(!live)("pgVerifyGuard (live DB)", () => {
  afterAll(async () => {
    await db()`DELETE FROM rate_limits WHERE bucket IN ('verify_fail_src', 'verify_fail_acct') AND key LIKE ${`${key}%`}`;
  });

  it("counts per client and per account separately", async () => {
    await pgVerifyGuard.recordFailure(EMAIL, "client-a");
    await pgVerifyGuard.recordFailure(EMAIL, "client-a");
    await pgVerifyGuard.recordFailure(EMAIL, "client-b");
    expect(await pgVerifyGuard.failures(EMAIL, "client-a")).toEqual({ source: 2, account: 3 });
    expect(await pgVerifyGuard.failures(EMAIL, "client-c")).toEqual({ source: 0, account: 3 });
  });
});
