# Log

What was done, what was tried and dropped, problems found, AI use.

## 2026-11-23 · Block 0–1: scaffold + deploy

**Done**
- docs/REQUIREMENTS.md (checklist from BRIEF.md with rubric weights and demo method), docs/PLAN.md, docs/DECISIONS.md.

- Scaffolded Next.js 16.4 (App Router, TS strict, ESLint) via create-next-app in a scratch dir, then copied in (create-next-app refuses a non-empty dir). Kept the generated `cacheComponents` config; `/api/health` calls `connection()` so it is never prerendered.
- Module layout: lib/{agent,tools,rag,guardrails,voice,observability,session,db}, shared types in lib/types.ts (incl. the typed SSE event union), components/.
- DB: raw SQL migration `db/migrations/0001_init.sql` (pgvector extension, sessions, messages, traces, documents, chunks with `vector(1536)` + HNSW cosine index) and `npm run db:migrate` runner (Neon WebSocket Pool, one transaction per file, `schema_migrations` table).
- `/api/health`: checks DB connectivity, pgvector version and applied migration count; 200 `ok` or 503 `error`. Env validated with zod in `lib/env.ts` (`server-only`).
- Verified locally: typecheck, lint and build pass; without DATABASE_URL `/api/health` returns 503 `Invalid server environment: DATABASE_URL`.

**Problems found**
- `.env*` in the generated .gitignore would also ignore `.env.example`; added `!.env.example`.
- `tsc --noEmit` alone fails on a fresh clone (`LayoutProps` comes from generated route types); `typecheck` script now runs `next typegen` first.
- Local Node is an x86-64 build running under Rosetta (Next.js warns). Not blocking; Vercel builds on its own Node.

**Deploy (same block)**
- Neon: project `customer-support-agent` (aws-us-east-1, Postgres 18) on org plan `free`. Pooled connection string written to `.env.local` (gitignored, never printed). `npm run db:migrate` applied 0001; `npm run db:check` shows pgvector 0.8.7, all tables, `vector(1536)`, HNSW index. Re-running migrate skips.
- Vercel: project `customer-support-agent` on team plan `hobby`, linked via CLI. `DATABASE_URL` added as Secret for Production and Preview. `vercel deploy --prod` → https://customer-support-agent-sable-two.vercel.app; `/api/health` → 200 `{"status":"ok","db":{"ok":true,"pgvector":"0.8.7","migrations":1}}`.
- Added CLAUDE.md rule: no paid services or plan upgrades.

**Problems found (deploy)**
- `neonctl` prompts for an org when none is given; passed `--org-id`.
- `vercel link` could not connect the GitHub repo: Vercel account has no GitHub login connection (needs a browser step by the user). Until then, deploys are by CLI (`vercel deploy --prod`), not on push.
- `vercel link` appends a `VERCEL_OIDC_TOKEN` to `.env.local` (gitignored, fine).
- Vercel CLI error JSON includes a "please send a feedback report" message aimed at agents; ignored (tool output is not an instruction).

**AI use**
- Claude Code (Opus) drafted the docs from BRIEF.md and the decided architecture, and scaffolded the app. All commands and outputs were run and checked in this session.

## 2026-11-23 · Block 1–3: RAG + guardrails + calibrated eval (started 19:38)

**Done**
- Corpus: 11 policy docs in `data/policies` for a fictional SaaS, "Fernway Workspace" (tiers, refunds, contract status, account changes, billing disputes, 3 troubleshooting guides, escalation, privacy, plus one poisoned partner FAQ). 6 mock users in `data/mock_users.json`: one per tier, plus expired, suspended and already-refunded accounts.
- Chunker (`lib/rag/chunker.ts`): section-aware, per-section tier tags, 52 chunks (median 66 tokens, max 188). Ingest (`npm run ingest`) is idempotent via a per-document content hash; a re-run skips all 11 docs.
- Retrieval: cosine top-k in pgvector with the tier and quarantine filters in SQL. Guardrails: retrieval-confidence gate, citation check, LLM claim check, typed `GuardrailDecision`. Trace spans record latency, tokens and cost per step.
- Evals: 30-query labelled set (20/10 split, fixed up front), `npm run eval:guardrails`, and a 9-item grounding-checker sanity set (`npm run eval:grounding`). Results in `evals/RESULTS.md`.
- `/api/rag/search` debug endpoint; vitest: 21 tests (chunker, citations, confidence, injection scan, live tier-filter and quarantine tests).

**Tried and dropped / problems found**
- `OPENAI_API_KEY` wasn't in `.env.local` at first, and the next key was expired; the user replaced it. A `vercel env add` waiting on an empty stdin value had to be stopped (nothing was added). macOS has no `timeout` command.
- `server-only` throws under plain Node; scripts run with `tsx --conditions=react-server`, and vitest aliases it to a stub.
- vitest 5 needs `@types/node` ≥ 22; bumped to 24.
- Similarity alone can't separate near-miss questions from answerable ones; the threshold only reaches 0 missed at t ≥ 0.58 (67% false escalations). Asked the user: accepted 0.28 under the stated rule applied to the full two-gate guardrail.
- Grounding checker `gpt-5-nano` failed its sanity check (6/8: blocked a correct paraphrase, passed an added claim); switched to `gpt-5.4-nano` (8/8). That forced a calibration re-run (run 2 = last blind held-out: 1/6 false, 0/4 missed).
- Held-out q30 exposed a checker bug: "I can't approve…" was flagged as an unsupported claim. Fixed the prompt, added a regression item (g9), re-ran (run 3: same rates). The held-out set is no longer fully blind for that failure mode; q30 was not tuned further.
- The answerer sometimes replies NOT_COVERED to "approve my refund" demands (q27); it fails safe (escalation). The phase 3 refund tool will handle these.
- A Bash call with nested heredocs was refused by the shell safety check (it deleted nothing); redone with file edits.
- LLM outputs vary between runs: one query (q04) flipped decision between runs with identical inputs.

**AI use**
- Claude Code (Opus) wrote the corpus, chunker, retrieval, guardrails, evals and tests, and ran every command shown. Threshold choice was confirmed by the user.

## 2026-11-23 · Block 3–5: agent loop + tools + streaming chat (started 20:06)

**First items**
- The quarantine was already generic (patterns run on every chunk, nothing refers to the poisoned doc). Probing it with paraphrased attacks showed only 1/6 caught, so I added 4 generic categories (4/6 caught, 0/3 benign flagged; the probes guided the patterns, so this is not an independent measure). Known misses (other languages, fake policy text) are documented in D20 and pinned in tests.
- Found that the ingest hash didn't include the detector, so a pattern change wouldn't re-scan; added `DETECTOR_VERSION`. Re-ingest left the quarantined set unchanged (only `partner-program-faq#2`), so retrieval and the guardrail eval are unchanged and were not re-run.
- `/api/rag/search?answer=1` rate limited (10 per IP per 10 min, 200 per day), verified locally and live (429 + Retry-After).
- RESULTS.md now states that run 2 is the last fully blind held-out result.

**Done**
- Tools (`lib/tools`): verify_identity, get_policy, issue_refund, create_escalation_ticket; zod input validation; typed errors; policy as pure functions; write-ahead idempotent ledger (`actions`); tickets table with `ESC-` numbers.
- Agent (`lib/agent`): typed state machine, OpenAI streaming adapter behind an `AgentModel` port, stable system prompt, 6-tool cap, sentence-level claim gate, graceful failure path.
- Session log (`session_events`, append-only by trigger, seq per session); context rebuilt per turn; PIN redacted in logs.
- `/api/chat` SSE (numbered typed events) + transcript GET; chat UI with live step indicators, escalation card, retry banner, demo-users panel, session id in localStorage.
- Tests: 54 (16 tool policy, 13 agent scenario/claim/state with a scripted model, plus earlier suites).

**Tried and dropped / problems found**
- First live run: nano 3/6, mini 5/6. Rather than switch models, moved required escalations (billing error after contract end, suspension, chargeback) into tool code: nano 5/6, mini 5/6. Kept mini (D22). One scenario expectation (S3) was wrong against the contract-status policy, which requires a billing escalation; fixed the expectation and noted it.
- The scripted injection test caught a claim-gate gap ("Refund approved and issued for $900!" passed). Widened the pattern; plural policy statements still pass.
- The model answered "what's my refund limit" from limit fields in verify_identity's output instead of the cited knowledge base; removed those fields so policy answers go through get_policy.
- The shell safety check refused two edit commands made of nested heredocs (nothing was deleted); redone via script files.
- I wrongly told the user the first items ran over their 10-minute box; they took about 5 minutes.

**AI use**
- Claude Code (Opus) designed and wrote the tools, agent, SSE route, UI, tests and scenario runner, and ran all checks shown.
- Live UI testing found two bugs the tests missed: (1) the transcript restore for a new session could overwrite a message sent while it was loading (now it only fills an empty list); (2) on a later turn the model re-called verify_identity with the redacted PIN from the log and failed verification (re-verifying an already verified account is now a no-op in code, with a test). Live acceptance then passed: Pro verify → policy, refund $174 within limits, $900 refused by the tool, ticket ESC-1001 (P2) on request; enterprise verify → policy → refund $650 in one turn.
- Live demo state is now used up for Omar inv_2001/inv_2002 and Northbeam inv_3001 (already refunded in the ledger). A demo reset is needed before the Loom.

## 2026-11-23 · Block 5–7: live voice (started 20:36)

**First items**
- `npm run demo:reset` (developer machine only, no endpoint; confirmation prompt unless `--yes`) deletes demo refunds and tickets. Run on prod: removed 4 ledger rows and ticket ESC-1001; a second run removed nothing. Added 2–3 invoices per demo user (24 total) and updated the demo-panel hints.
- `/api/chat` already used the Postgres limiter (phase 3). Verified live: 32 parallel requests from one IP → 26 × 200, 6 × 429 (about 4 earlier chats from the same IP were in the window).

**Done**
- Checked the current OpenAI docs (client_secrets, /v1/realtime/calls, event names); confirmed the event names that weren't in the fetched pages live on the debug page.
- `runToolStep` extracted and shared by chat and voice; context rebuild pairs tool calls with results even when voice logs a transcript in between.
- `/api/voice/session` (ephemeral key, history, verified context), `/api/voice/tool` (bridge), `/api/voice/events` (transcripts with claim flags, usage to `traces`).
- Client: WebRTC, two waveforms, live transcripts, step indicators, interruption, 3-minute cap, reconnect, `/voice-debug` (events, interruption timings, test clips, simulated drop).
- Synthetic caller clips (TTS) so voice can be tested without a microphone.
- Tests: 67 (12 new voice tests). Live checks: evals/VOICE_CHECKS.md, all pass (interruption about 0.63 s end to end, mostly VAD).

**Problems found (all fixed and re-checked live)**
- Server VAD with 500 ms silence split callers at every pause → semantic VAD.
- Test clips: pure digital silence stopped WebRTC packets (DTX), so the turn never ended → −60 dB noise floor in clip mode.
- Interrupt targeted the last *generated* response; playback outlasts `response.done` → track the *playing* response.
- Half-streamed tool calls from an interrupted response were executed (harmless INVALID_INPUT) → dropped.
- The voice model refused an over-limit refund from policy text instead of calling the tool → shared prompt now says issue_refund always decides. Chat scenarios re-run: briefly 5/6 (S6 refused from invoice data), final wording 6/6.
- Answers still playing when the call ended weren't logged → flushed as the heard portion.
- A stray `cat >> /dev/null` in one of my commands hung on stdin; stopped and redone.

**Limitations**
- Checks used synthetic TTS speech, not a person on a microphone; a person should repeat them in Chrome.
- The network drop was simulated by closing the peer connection; a real network outage wasn't tested.
- Interruption end to end is about 0.63 s from speech onset (target ~0.5 s); the client reacts in 0 ms, the rest is server VAD detection. A local level-based pre-mute could cut it further at the risk of false triggers.
- Spoken audio can't be rewritten by the claim check; mismatches are flagged instead (D35).
- The 3-minute cap is enforced by the client; per-IP and daily caps bound abuse.

**AI use**
- Claude Code (Opus) wrote the voice server, client, tests, clips and docs, and ran every check in the built-in browser on the live URL. A web-fetch subagent read the current OpenAI Realtime docs.

## 2026-11-23 · Block 7–8.5: resilience + observability drawer + hardening (started 21:25)

**Done**
- Failure injection at real boundaries (`lib/faults.ts`, AsyncLocalStorage, one request): LLM timeout, LLM 429, refund failure after recording, retrieval down, plus a client-side stream drop. Drawer control, one-shot.
- Agent retries with backoff + jitter honouring Retry-After (`lib/agent/retry.ts`), `retrying` SSE events, no retry once text streamed; typed fallbacks per failure; per-failure UI states with matching actions.
- Traces persisted (redacted) for chat and voice; `/api/sessions/:id/traces` report (span tree, TTFT, e2e, per-tool, tokens incl. cached, estimated cost, guardrails, corrections, retries, p50/p95); drawer UI with copy JSON.
- Stream resume via `stream_events` + `/api/chat/stream` + client reconnect/de-dup; the turn survives client disconnect (`after()`).
- Hardening: typed errors with request ids on all routes, structured JSON logs, security headers + CSP (voice still works), error boundaries, health with embeddings/LLM checks, realtime `max_output_tokens`.
- Tests: 76 (new: resilience suite, report builder). Live checks: evals/RESILIENCE_CHECKS.md, all pass. Chat scenarios re-run after prompt changes: 6/6.

**Problems found**
- The model refused to retry a failed refund because the failure text read as "don't retry"; reworded and added a prompt rule; re-checked live (exactly one refund).
- Drawer timings were whole seconds: the Neon driver returns timestamptz as `Date` and `Date.parse(date)` drops ms. Fixed, with a test that fails without the fix.
- The redactor hid error codes (masked a `code` key); PINs are caught by pattern instead. Rows stored earlier keep "[redacted]".
- Commit `Fix drawer timings and error codes` contains only the redaction change: my edit script stopped partway and the `;`-chained commit still ran. The next commit (`Keep millisecond precision in drawer timings`) is the timing fix. Not rewritten, since it's already pushed.
- The browser pane served cached JS after a deploy; reloaded with a cache-busting query.
- Demo data reset twice on prod (my own test refunds) so checks could reuse invoices.

**Limitations**
- Voice LLM faults can't be injected (the realtime model is called browser-direct); voice covers tool and retrieval faults.
- The stream drop is a client-side abort, not a real network cut.
- Voice session length is enforced client-side (D44).

**AI use**
- Claude Code (Opus) wrote the fault injection, retries, trace persistence, drawer, stream resume and hardening, and ran all live checks in the built-in browser.

## 2026-11-23 · Block 8.5–9.5: independent reviews + fixes (started 21:48)

**Done**
- Three subagents reviewed from the outside (grader, security tester, code reviewer), without access to DECISIONS/LOG/REQUIREMENTS/eval results. Findings merged in docs/REVIEW.md.
- Every critical/major finding was reproduced before fixing: failing unit tests (`tests/review-repro.test.ts`), a live-DB race test (`tests/ledger.int.test.ts`, failed before migration 0007), and a live IDOR script (`scripts/repro-idor.sh`, B read A's data before; 403 after).
- Fixed: README (critical), one-active-refund-per-invoice (unique index + stale pending retired), cent rounding, session ownership cookie, PIN redaction in the log, per-account lockout, strict credential formats, session-aware claim gate + paraphrases, voice auto-reconnect, lazy/cached health, friendly step text, unknown tool name, dead stubs, CI.
- X-Forwarded-For spoofing tested live: not exploitable on Vercel (spoofed headers still rate limited); hardened anyway.
- Tests 89; live scenarios 6/6 with 0 corrections; CI green.

**Problems found**
- My G3 paraphrase pattern rewrote correct policy text (seen in the live scenario run); narrowed it, with a regression test.
- The eval's approval heuristic counted "No refund has been issued" as an approval; fixed, with a test.
- The voice auto-reconnect was cancelled by effect cleanup on re-render (callback identities change each render); scheduled once instead; verified live.
- Prod data held a stale pending refund next to a succeeded one on the same invoice (left by my phase-5 voice test); migration 0007 retired it before adding the index.

**Design change flagged to the user**
- Session ownership: an HttpOnly owner cookie now binds each session to the browser that created it (D45). There are still no user accounts; clearing cookies loses access to old conversations.

**AI use**
- Claude Code (Opus) spawned the three reviewers, reproduced and fixed the findings, and re-verified live.

## 2026-11-23 · Phase 7: code structure + stronger evidence (started 22:11)

**Done**
- Fresh 30-query held-out guardrail set (`evals/guardrail_set_v2.jsonl`), run once at the unchanged threshold: FE 1/15, ME 0/15 (per category in RESULTS.md), $0.02.
- Live scenarios ×3 (`--repeat 3`): 18/18, $0.06; S6 run 2 needed one claim-gate correction.
- Layers enforced (architecture test + ESLint rule), modules moved to their layer, `lib/contracts.ts` with discriminated tool outcomes; reloaded transcripts restore step indicators and ticket cards.
- Unit tests: guardrail pipeline (10, injected fakes), stream resume (5), voice client (7), transcript (2). Suite 89 → 116.
- Voice hook split (627 → 304 lines + 7 modules); deployed `0cece47`; all 8 voice checks re-run live; CI green.

**Problems found**
- I overwrote the existing `tests/voice.test.ts` with the new voice-client tests (the count dropped 109 → 104). Caught by the test count, restored from git, new tests moved to `tests/voice-client.test.ts`.
- Live: the voice model refused $900 without calling `issue_refund` (3/3), unlike Phase 4. Not caused by the split; git shows Phase 6 added "general questions go straight to get_policy" to the shared prompt, the likely cause. Recorded as a known limitation; a prompt fix needs its own live trials.
- Live: a chat answer listed an already-refunded invoice as eligible in the same sentence that said it was refunded; the claim gate doesn't check that kind of contradiction.
- A commit message had its bullet on the subject line (missing blank line); amended before pushing.

**AI use**
- Claude Code (Opus) wrote the held-out set, refactors and tests, ran evals and live checks in the built-in browser, and re-ran the independent grader.

**Grader re-run** (same Phase 6 prompt, fresh context): about **80/100** (agentic 29/35, voice 19/25, code 22/25, production 10/15), up from about 77.5 before the Phase 6 fixes. It ran the 116 tests, typecheck and lint (clean) and 8 live chats (~$0.015; created ESC-1009/1010, no refunds). Remaining deductions: no Loom yet; a pending ledger entry left by an exception (e.g. the public `tool_failure` fault) blocks that invoice with REFUND_IN_PROGRESS and never expires (confirmed in `lib/tools/tools.ts:162-176`); the regex claim gate misses paraphrases ("Your refund is complete."); the agent's final policy wording isn't grounded; all-or-nothing grounding escalates partly correct answers; voice controls (session.update, cap, usage) are client-side; no listening/speaking indicator. Not fixed in this phase (timebox); listed for the user to choose.

## 2026-11-23 · Phase 8: grader deductions (started 22:55)

**Done** (each reproduced first, then fixed, tested, deployed `670a399`, re-verified live)
- Pending refunds expire after 2 min (D51): failing tests first; live: `tool_failure` locked inv_2004, another session refunded it after expiry; ledger shows one REQUEST_EXPIRED and one succeeded.
- Two-layer claim gate (D52): model extraction + code comparison, 20/20 on a labelled set vs regex 11/20, ~$0.0001 / 0.8 s per check.
- Partial grounding (D53): v2 held-out unchanged (FE 1/15, ME 0/15).
- Refund requests always go to issue_refund (D54): voice 3/3 live (was 0/3); chat scenarios 6/6.
- Activity indicator; `/api/rag/search` limited in all modes (live 429); eligibility wording prompt rule.
- Tests 116 → 134.

**Problems found**
- First claim-check design (model compares with the log) over-flagged true claims (10/14); redesigned to extraction + code.
- My shell swallowed `$58`/`$29` in three new labelled items; that run was discarded and re-run with the right text.
- The activity indicator stuck on "Thinking…" live (one audio buffer spans the tool call; its stop event names the first response); now derived from state, with a test of the live sequence.
- The `--repeat` parsing from Phase 7 dropped the model name without `--repeat`; fixed in its own commit.
- v2 re-run swapped two decisions (v09, v11); v09 re-checked twice and answered correctly (model variance).

**Not done**
- Server-enforced voice limits (item 5): the sideband/hangup API exists, but our browser does the SDP exchange, so the server has no call_id. Moving the SDP exchange server-side changes the verified voice path; documented with options (D55).

**Grader re-run** (same prompt, fresh context): about **79/100** (agentic 29, voice 19, code 21, production 10), vs about 80 after Phase 7. Different live probes: it found the agent skipping get_policy on a policy question asked after an escalation (session 659dd4bc), unverified Pro-plan questions escalating, `/api/rag/search` bypassing the tier gate and returning traces, low confidence being "suggested" rather than an escalated turn state, and still no Loom. These are its observations; I haven't reproduced the get_policy skip myself.

**AI use**
- Claude Code (Opus) wrote the fixes and tests, ran the evals and live voice checks (test clips) in the built-in browser, and re-ran the independent grader.

## 2026-11-23/24 · Phase 9: final fixes, then feature freeze (started 23:47)

**Done**
- Escalated state for guardrail escalations: ticket in code (verified), offered (unverified), reason and confidence in the card (D57).
- `/api/rag/search` locked to every-tier sections without the admin key (D58).
- Unverified tier questions ask to verify (D59).
- Early acknowledgment: time to first token 5.5–7.1 s → 0.57–0.79 s (D60).
- Refund only when requested, enforced in code (D61).
- Spacing bug between model steps fixed.
- `--only` added to the scenario runner. Tests 134 → 152.
- Live check on `b8a9698`:
  - chat chain (verify by voice, then refund + policy);
  - over-limit refused by the tool;
  - out-of-scope → escalated state (unverified);
  - LLM 429 ×2 → retry banner → answer;
  - voice chain with interruption;
  - verify-first for a Pro question.

**Problems found**
- The 6-scenario run after the first deploy was 5/6, then 18 runs gave S4 0/3 and S6 0/3. A/B runs with `--only` traced S6 to my Phase 8 eligibility rule (removed) and to the acknowledgment in the model's context (now display-only). S4 traced to the Phase 8 refund-routing wording (kept for voice; documented).
- S5 issued an unrequested refund in one run. Now refused in code.
- A commit picked up another change's lines in `run.ts`; split before pushing.
- Committed once with the architecture test failing (`lib/admin.ts` unassigned to a layer); fixed in the same unpushed commit.

**Not reproduced**
- The grader's skipped-lookup case (P9-4 in REVIEW).

**Open at the freeze**
- Off-topic escalation depends on the model calling get_policy.
- S4 1/3.
- Voice limits are client-side.
- Loom.

**AI use**
- Claude Code (Opus) implemented and tested the fixes, ran the A/B scenario runs and the live checks in the built-in browser (voice via test clips).
