# Resilience checks

**When:** 2026-11-23, 21:34–21:46 local (2026-11-24 02:34–02:46 UTC).
**Where:** live URL `https://customer-support-agent-sable-two.vercel.app`, session `2124e687`, in the Claude desktop app's built-in browser (Chromium), using the drawer's "Failure simulation" control (one-shot, applies to the next turn or voice tool call).

**How the faults are injected (not just a UI message):** the fault is scoped to one request with AsyncLocalStorage (`lib/faults.ts`) and injected at the real boundary, so the real error handling runs:
- **LLM timeout:** the real OpenAI call with a 1 ms timeout, so the SDK raises a real `APIConnectionTimeoutError` on every attempt.
- **LLM 429:** the OpenAI SDK gets a fetch that returns a genuine HTTP 429 with `retry-after: 1` for the first two calls, so the SDK raises a real `RateLimitError`; the third call goes to OpenAI.
- **Tool failure:** `issue_refund` throws *after* its ledger entry is written (pending), as a payment processor failure would.
- **Retrieval down:** the embeddings call goes to an unreachable host (`127.0.0.1:9`), giving a real connection error.
- **Stream drop:** the client aborts its SSE connection after the first completed step (client-side; the server keeps running the turn).

| # | Failure | Handling | Live result | Next turn |
|---|---|---|---|---|
| 1 | Normal 3-tool turn (baseline) | n/a | verify → get_policy → issue_refund ($29, inv_2004); drawer shows the full trace (see `docs/screenshots/drawer-chat-3-tool-turn.jpg`) | n/a |
| 2 | Refund tool fails mid-chain (after identity + policy succeeded) | Tool returns typed `TOOL_FAILURE` (retryable); the ledger entry stays `pending`; `error` event `tool_failed`; the reply states nothing was refunded | **Pass.** ✕ step, honest reply, banner "Couldn't complete the refund; nothing was refunded…" with **Try the refund again** / **Open a ticket**. The first live run found that the model read the failure text as "don't retry"; I fixed the wording and prompt (commit `Make retryable tool failures retry on request`) | **Pass.** "Please try the $58 refund for inv_2005 again" → ✓ refund issued. Ledger: **exactly one** row for inv_2005, the same idempotency key resumed `pending` → `succeeded` |
| 3 | LLM 429 rate limit | Retry with backoff + jitter, honouring Retry-After; `retrying` events; no retry once text has streamed | **Pass.** Banner "The assistant is busy, retrying… (attempt 2 of 3, rate limited)", then a normal grounded answer | n/a (recovered in the same turn) |
| 4 | LLM timeout (every attempt) | Per-call timeout; 3 attempts with backoff; then a typed `llm_timeout` error and a fallback reply that states what the turn did | **Pass.** "Sorry, the assistant took too long to respond. Nothing was changed. Please try again in a moment." + timeout banner with **Retry**; drawer shows the turn as `failed`, 0 tokens | **Pass.** Retry → normal answer (export data, confidence 0.703) |
| 5 | Knowledge base / embeddings unavailable | `get_policy` returns typed `SERVICE_UNAVAILABLE`; `error` event `retrieval_unavailable` | **Pass.** ✕ "The knowledge base is temporarily unavailable"; the agent offered a ticket; banner with **Retry** / **Open a ticket** | **Pass.** Retry → normal answer (closure policy, confidence 0.625) |
| 6 | Voice: refund tool fails | Same tool step as chat → `TOOL_FAILURE` output to the realtime model | **Pass.** Spoken fallback: "That refund didn't go through on the tool's side, so nothing was refunded. It looks retryable, so I can try again if you'd like."; the refund banner was shown in the transcript | n/a |
| 7 | Chat stream drops mid-turn | Each numbered event is also logged per stream; the client reconnects to `/api/chat/stream?streamId&after=N`, the server replays seq > N then follows to `done`; the client drops seq ≤ last; the turn keeps running server-side (`after()`) | **Pass.** Dropped after event 2; resumed: one step, the full answer once, "stream resumed after event 2" | n/a |

**Drawer:** a chat 3-tool turn and a voice turn both show a complete trace with estimated cost (`docs/screenshots/drawer-chat-3-tool-turn.jpg`, `docs/screenshots/drawer-voice-turn-and-session.jpg`). Session after these checks: 10 turns; chat p50/p95 1.59 s / 5.87 s; TTFT p50/p95 1.46 s / 5.72 s; voice response 462 ms; est. $0.0215 (chat $0.0139, voice $0.0076).

**Bugs found by these checks and fixed:**
- Refund-failure wording made the model refuse to retry.
- Drawer durations were rounded to whole seconds (the driver returns `Date`).
- The redactor hid error codes because it masked a `code` key. Rows stored before that fix still show "[redacted]", because traces are redacted at write time.

**Not simulated:** a real OpenAI outage, a real DB outage for the whole app (the health endpoint reports it, and chat returns a typed 503 if the rate-limit/DB check fails), and a real network cut in the browser (the stream drop is a client-side abort).
