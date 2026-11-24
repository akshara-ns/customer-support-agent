/**
 * Generates the synthetic "caller" clips used by /voice-debug to test voice without a microphone.
 * Usage: npm run voice:clips   (writes public/voice-test/*.mp3 and clips.json)
 */
import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
config({ path: ".env.local", quiet: true });

export const CLIPS: { id: string; label: string; text: string }[] = [
  { id: "verify", label: "Verify (Omar)", text: "Hi, this is Omar. My email is omar at example dot com, and my support PIN is seven one five two zero four." },
  { id: "policy", label: "Ask refund policy", text: "What's the refund limit and the refund window on my plan?" },
  { id: "refund", label: "Refund $29 seat", text: "Please refund the twenty-nine dollar charge for the extra seat I added mid-month." },
  { id: "overlimit", label: "Refund $900 (over limit)", text: "Can you refund nine hundred dollars of my annual plan invoice?" },
  { id: "escalate", label: "Yes, escalate", text: "Yes, please escalate that to the billing team." },
  { id: "long", label: "Long question", text: "Can you walk me through everything I should try when the desktop app won't sync? Please explain each step in detail." },
  { id: "interrupt", label: "Interrupt", text: "Sorry, stop there. Just tell me how long refunds take to arrive." },
  { id: "invoices", label: "Which invoices?", text: "Which of my invoices can I still get refunded?" },
];

async function main(): Promise<void> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  for (const c of CLIPS) {
    const res = await client.audio.speech.create({ model: "gpt-4o-mini-tts", voice: "ash", input: c.text, response_format: "mp3" });
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(`public/voice-test/${c.id}.mp3`, buf);
    console.log(`${c.id}.mp3 ${buf.length} bytes`);
  }
  await writeFile("public/voice-test/clips.json", JSON.stringify(CLIPS.map(({ id, label, text }) => ({ id, label, text })), null, 2) + "\n");
}
main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
