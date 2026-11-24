/** Mints one realtime client secret with the production session config and prints only non-secret facts. */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

async function main(): Promise<void> {
  const { openAISecretMinter, voiceSessionConfig } = await import("@/lib/voice/session");
  const { SYSTEM_PROMPT } = await import("@/lib/agent/prompt");
  const mint = openAISecretMinter(process.env.OPENAI_API_KEY ?? "");
  const cfg = voiceSessionConfig(SYSTEM_PROMPT);
  const s = await mint(cfg);
  console.log({ keyPrefix: s.value.slice(0, 3), keyLength: s.value.length, expiresInSec: s.expiresAt - Math.floor(Date.now() / 1000), model: cfg.model, tools: cfg.tools.map((t) => t.name) });
}
main().catch((e: unknown) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
