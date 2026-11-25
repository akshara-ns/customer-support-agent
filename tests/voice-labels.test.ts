import { describe, expect, it } from "vitest";
import { voiceButtonLabel, voiceStatusLabel, voiceTimer } from "@/components/voice/voiceLabels";

describe("voice labels", () => {
  it("header button opens with 'Voice' and closes with 'Close voice'", () => {
    expect(voiceButtonLabel(false)).toBe("Voice");
    expect(voiceButtonLabel(true)).toBe("Close voice");
  });

  it("panel open with no call says how to start", () => {
    expect(voiceStatusLabel("idle", "listening")).toBe("Ready: press Start voice");
  });

  it("during a call the status is the live activity", () => {
    expect(voiceStatusLabel("live", "listening")).toBe("Listening");
    expect(voiceStatusLabel("live", "thinking")).toBe("Thinking…");
    expect(voiceStatusLabel("live", "speaking")).toBe("Speaking");
  });

  it("other states keep their own labels and the timer formats m:ss", () => {
    expect(voiceStatusLabel("connecting", "listening")).toBe("Connecting…");
    expect(voiceStatusLabel("ended", "listening")).toBe("Ended");
    expect(voiceTimer(65, 180)).toBe("1:05 / 3:00");
  });
});
