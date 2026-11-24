import { describe, expect, it } from "vitest";
import { buildTranscript } from "@/lib/server/transcript";
import type { StoredEvent, SessionEvent } from "@/lib/session/events";

let seq = 0;
const ev = (turnId: string, event: SessionEvent, channel: "chat" | "voice" = "chat"): StoredEvent => ({
  seq: ++seq,
  turnId,
  channel,
  createdAt: "2026-11-23T00:00:00Z",
  event,
});

describe("transcript reload", () => {
  it("attaches each turn's tool steps and ticket to the assistant message that follows", () => {
    seq = 0;
    const events: StoredEvent[] = [
      ev("t1", { type: "user_message", text: "Hi, I'm o***@example.com, PIN [pin]" }),
      ev("t1", { type: "tool_call", toolCallId: "c1", name: "verify_identity", arguments: "{}" }),
      ev("t1", {
        type: "tool_result",
        toolCallId: "c1",
        name: "verify_identity",
        result: { ok: true, data: { customer_id: "x", tier: "pro", contract_status: "active", contract_end: null, already_verified: false, invoices: [] } },
        effects: {},
      }),
      ev("t1", {
        type: "tool_result",
        toolCallId: "c2",
        name: "issue_refund",
        result: { ok: false, error: { code: "OVER_TIER_LIMIT", message: "$900 is above the $200 limit.", retryable: false } },
        effects: {},
      }),
      ev("t1", { type: "assistant_message", text: "I can't refund $900." }),
      ev("t2", { type: "user_message", text: "escalate", }, "voice"),
      ev("t2", {
        type: "tool_result",
        toolCallId: "c3",
        name: "create_escalation_ticket",
        result: { ok: true, data: { ticketNumber: "ESC-1001", priority: "P2", reason: "refund_over_limit", responseTarget: "1 business day", status: "open", replayed: false } },
        effects: { ticket: { ticketNumber: "ESC-1001", priority: "P2", reason: "refund_over_limit", responseTarget: "1 business day", status: "open", replayed: false } },
      }, "voice"),
      ev("t2", { type: "assistant_message", text: "Ticket created.", interrupted: true }, "voice"),
    ];
    const t = buildTranscript(events);
    expect(t.map((l) => l.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(t[1].steps?.map((s) => [s.tool, s.status, s.label])).toEqual([
      ["verify_identity", "ok", "Verifying identity and account tier…"],
      ["issue_refund", "error", "Checking refund policy and issuing refund…"],
    ]);
    expect(t[1].steps?.[0].summary).toBe("Verified: pro tier, contract active");
    expect(t[3]).toMatchObject({ channel: "voice", interrupted: true, ticket: { ticketNumber: "ESC-1001", priority: "P2", responseTarget: "1 business day" } });
  });

  it("shows steps of a turn whose reply was never logged (e.g. a failed turn)", () => {
    seq = 0;
    const t = buildTranscript([
      ev("t1", { type: "user_message", text: "refund" }),
      ev("t1", {
        type: "tool_result",
        toolCallId: "c1",
        name: "issue_refund",
        result: { ok: false, error: { code: "TOOL_FAILURE", message: "x", retryable: true } },
        effects: {},
      }),
    ]);
    expect(t).toHaveLength(2);
    expect(t[1]).toMatchObject({ role: "assistant", text: "", steps: [{ status: "error", summary: "Refund failed; nothing was refunded" }] });
  });
});
