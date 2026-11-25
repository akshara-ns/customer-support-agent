/** UI state helpers: account status chip and the verify message used by the demo cards. */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/components/agentEvents";
import { accountStatus, statusLabel, verifyMessage } from "@/components/chatUi";
import { TRY_PROMPTS } from "@/components/tryPrompts";
import type { DemoUser } from "@/lib/contracts";

const users = [{ name: "Omar Haddad", email: "omar@example.com", pin: "715204", tier: "pro", contractStatus: "active", tryThis: "" }] as DemoUser[];
const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(), role: "assistant", text: "", steps: [], ...m }) as ChatMessage;
const verified = msg({ steps: [{ stepId: "s", tool: "verify_identity", label: "", status: "ok", summary: "Verified: pro tier, contract active" }] });

describe("account status chip", () => {
  it("is 'Not verified' until a verify step succeeds", () => {
    expect(statusLabel(accountStatus([], users))).toBe("Not verified");
    const failed = msg({ steps: [{ stepId: "s", tool: "verify_identity", label: "", status: "error", summary: "Email and PIN didn't match (attempt 1 of 3)" }] });
    expect(statusLabel(accountStatus([failed], users))).toBe("Not verified");
  });
  it("shows the first name and tier when the typed email matches a demo user", () => {
    const typed = msg({ role: "user", text: "Hi, I'm omar@example.com and my support PIN is 715204." });
    expect(statusLabel(accountStatus([typed, verified], users))).toBe("Verified · Omar (Pro)");
  });
  it("after a reload (redacted email) shows the tier only", () => {
    const redacted = msg({ role: "user", text: "Hi, I'm o***@example.com and my support PIN is [pin]." });
    expect(statusLabel(accountStatus([redacted, verified], users))).toBe("Verified (Pro)");
  });
});

describe("verify message", () => {
  it("matches the Try-this verify prompt", () => {
    expect(verifyMessage(users[0])).toBe(TRY_PROMPTS[0].text);
  });
});
