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
