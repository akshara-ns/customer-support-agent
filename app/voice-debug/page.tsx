import { Chat } from "@/components/Chat";

export const metadata = { title: "Voice debug · Support Agent" };

/** Voice debugging: same chat + voice, plus connection state, data-channel events and test clips. */
export default function VoiceDebugPage() {
  return (
    <main className="layout layout-single">
      <Chat voiceDebug />
    </main>
  );
}
