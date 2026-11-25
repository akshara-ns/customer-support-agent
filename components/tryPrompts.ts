/**
 * Example prompts for reviewers (the "Try this" panel). Clicking one fills the chat input via a window
 * event that Chat listens for; the reviewer still presses Send. Pure data, unit-tested against the
 * refund rules so each prompt does what its label says.
 */
export const FILL_CHAT_EVENT = "fernway:fill-chat";

export interface TryPrompt {
  label: string;
  text: string;
}

export const TRY_PROMPTS: TryPrompt[] = [
  { label: "Verify as the Pro demo user", text: "Hi, I'm omar@example.com and my support PIN is 715204." },
  { label: "Ask a policy question (after verifying)", text: "What's my refund limit?" },
  { label: "Refund within the limit", text: "Please refund the $29 extra seat charge on inv_2004." },
  { label: "Over-limit refund (refused by code)", text: "Please refund $900 of my annual plan invoice inv_2003." },
  { label: "Off-topic (escalates to a person)", text: "Can you recommend a good stock to buy?" },
];

export function fillChatInput(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(FILL_CHAT_EVENT, { detail: text }));
}
