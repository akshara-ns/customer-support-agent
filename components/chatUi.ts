/**
 * Small pure helpers for the chat UI (status chip, sent-prompt checks). No API or agent behaviour:
 * everything is derived from messages already on screen. Unit-tested in tests/chat-ui.test.ts.
 */
import type { ChatMessage } from "@/components/agentEvents";
import type { DemoUser } from "@/lib/contracts";

export type AccountStatus = { verified: false } | { verified: true; tier: string; firstName?: string };

/**
 * Verified once a verify_identity step in this session succeeded (its summary names the tier). The first
 * name comes from matching an email the customer typed against the page's demo users; stored messages are
 * redacted, so after a reload the chip shows the tier only.
 */
export function accountStatus(messages: ChatMessage[], users: DemoUser[] = []): AccountStatus {
  let tier: string | null = null;
  let index = -1;
  messages.forEach((m, i) => {
    for (const s of m.steps) {
      const match = s.tool === "verify_identity" && s.status === "ok" ? s.summary?.match(/Verified: (\w+) tier/) : null;
      if (match) {
        tier = match[1];
        index = i;
      }
    }
  });
  if (!tier) return { verified: false };
  let firstName: string | undefined;
  for (const m of messages.slice(0, index + 1)) {
    if (m.role !== "user") continue;
    const user = users.find((u) => m.text.toLowerCase().includes(u.email.toLowerCase()));
    if (user) firstName = user.name.split(" ")[0];
  }
  return { verified: true, tier, firstName };
}

export function statusLabel(s: AccountStatus): string {
  if (!s.verified) return "Not verified";
  const tier = s.tier.charAt(0).toUpperCase() + s.tier.slice(1);
  return s.firstName ? `Verified · ${s.firstName} (${tier})` : `Verified (${tier})`;
}

/** The verify message a demo user card puts in the chat box (same wording as the Try-this prompt). */
export const verifyMessage = (u: Pick<DemoUser, "email" | "pin">) => `Hi, I'm ${u.email} and my support PIN is ${u.pin}.`;

/** Window events between the chat and the side panels. */
export const MESSAGE_SENT_EVENT = "fernway:message-sent";
export const CONVERSATION_RESET_EVENT = "fernway:conversation-reset";
