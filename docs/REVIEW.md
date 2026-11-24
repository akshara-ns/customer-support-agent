# Independent review (phase 6)

**When:** 2026-11-23, 21:48–22:10 local.
**Reviewers:** three subagents with no project context beyond BRIEF.md (with rubric), the repo and the live URL. They were told not to read DECISIONS.md, LOG.md, REQUIREMENTS.md, PLAN.md or the eval results.
1. **Grader** scored against the rubric. Estimate before fixes: about 77.5/100 (agentic 28/35, voice 19.5/25, code 20/25, production 10/15). Its biggest deduction was the missing README.
2. **Security & abuse tester** ran white-box attacks on the live deployment and spent about $0.01. It found no way past refund policy, identity checks or secret redaction.
3. **Code quality & design reviewer** produced a top-10 ranked list, import-graph and typing scans.

**Rule followed:** every critical or major finding was confirmed with a failing test or a live reproduction *before* the fix. After each fix the full suite was re-run, the app was deployed, and the fix was re-verified on the live URL. Decided design (models, threshold, tool policies, parallel tool calls off) was not changed. One addition, per-browser session ownership, is flagged below.

## Critical

| ID | Finding | Source | Evidence before | Fix | Evidence after | Status |
|---|---|---|---|---|---|---|
| C1 | No README.md, although the brief requires architecture, chunking and trade-offs | Grader, code review | `git ls-files \| grep -i readme` → nothing | README.md written: architecture diagram, module map, chunking, guardrail calibration, trade-offs, run/test/eval instructions, known limitations | README.md in repo | **Fixed** |

## Major

| ID | Finding | Source | Reproduction (before fix) | Fix | Verification (after) | Status |
|---|---|---|---|---|---|---|
| R1 | Valid cent amounts rejected: `$19.99` → `INVALID_AMOUNT` (`Math.round(x*100) !== x*100` is false in floating point) | Code review | `tests/review-repro.test.ts` "R1" failed (19.99, 1.15, 0.29, 4.35) | Compare whole cents with a 1e-6 tolerance (`lib/tools/policy.ts`) | Test passes; 10.555 still rejected | **Fixed** |
| R2 | One-refund-per-invoice was read-then-write: concurrent requests with different keys (amount, session, or chat + voice) could both succeed | Code review, grader, security (not reproduced live) | Unit "R2" failed (2 of 2 succeeded); **live DB** `tests/ledger.int.test.ts` failed: 3 concurrent `begin`s all created. Prod data also held a stale `pending` inv_2004 next to a `succeeded` one (completing it would have double-refunded) | Migration 0007: partial unique index `actions(customer_id, invoice_id) WHERE status IN ('pending','succeeded')`; stale pending rows retired; ledgers return the holding entry → `ALREADY_REFUNDED` / new `REFUND_IN_PROGRESS`; `MemoryLedger` mirrors the rule and `complete()` now requires pending (same contract as Postgres) | Both tests pass after the migration; a rejected request still frees the invoice | **Fixed** |
| S1 | No binding between a browser and its session: anyone with a session UUID could read the transcript and traces, write into the session, replay its stream, mint a voice key with the verified account context, and act as the verified customer via `/api/voice/tool` | Security, grader | `scripts/repro-idor.sh` on live: client B read A's transcript (200), traces (200), wrote into A's session (200) | **Design addition (flagged):** HttpOnly + Secure + SameSite=Lax random owner cookie; sessions store its SHA-256 (`migration 0008`, `lib/session/owner.ts`); every session-scoped route checks it (chat POST/GET, stream resume, traces, voice session/tool/events). First use claims an unowned session | Live repro after: A 200; B **403** on transcript, traces, write and voice mint. UI chat turn and drawer still work; cookie not visible to JS. `tests/owner.test.ts` | **Fixed** |
| G4 | Support PINs stored in plaintext in `session_events` and returned by the transcript API | Grader | `tests/review-repro.test.ts` "G4" failed (log contained 715204); live transcript showed "PIN 715204" | User messages (chat and voice transcripts) logged redacted (`[pin]`, masked email); the model still gets the raw text for the current turn only | Test passes; live stored text "Hi, I'm s***@example.com, PIN [pin]…" | **Fixed** |
| S2/G5 | 3-attempt lockout was per session: a new session id reset it (unlimited PIN guesses bounded only by the daily caps) | Security, grader | Security tester: attempt counter back to "1 of 3" in a new session; `tests/review-repro.test.ts` "G5" failed | Per-account lockout across sessions and channels: 5 failures per email per 15 min (`VerifyGuard`, Postgres-backed, email hashed); per-session lock kept | Test passes | **Fixed** |
| G2 | A hallucinated `verify_identity({email:"unknown"})` burned a real failed attempt (3 would lock the conversation and open a security ticket) | Grader (live) | "G2" test failed: placeholder → `VERIFICATION_FAILED` + counted | Strict schema: `z.email()` and `^\d{6}$` → `INVALID_INPUT`, never counted; prompt: never guess, general questions go to get_policy. Re-verifying the already-verified account stays a no-op | Tests pass; live chat scenarios re-run 6/6 | **Fixed** |
| G3 | Claim gate only knew the current turn: a true reference to an earlier refund was rewritten into a false "No refund has been issued yet"; paraphrases ("credited $500", "money is on its way") passed | Grader | "G3" tests failed | Gate seeded with refunds/tickets from the whole session log (chat and voice); paraphrase patterns added; policy text ("Refunds go back to…") still passes | Tests pass | **Fixed** |
| V1 | Voice "Reconnecting…" never reconnected on its own | Grader, code review | Code inspection; first live check of the fix showed the restart was cancelled by re-renders (log: `auto-reconnect` with no reconnect) | One automatic reconnect (new key, same session, history replayed) on peer failure / channel close / simulated drop; timer scheduled once; manual button after that | Live: drop → `auto-reconnect` → `live (history 2, verified true)` about 2 s later, no click | **Fixed** |
| Q1 | `useVoice.ts` is a 627-line hook mixing transport, event handling, interruption and the tool bridge, with ~13 casts on untyped realtime events | Code review, grader | n/a (structure) | Not refactored: behaviour is verified live (VOICE_CHECKS.md), and splitting it now risks regressions in the graded voice path | — | **Open → known limitation** |
| Q2 | Tool results typed `unknown` force casts downstream; `parsed.data as …` casts in the registry | Code review | n/a (typing) | Partly: the unknown-tool bug it hid is fixed (reported as `unknown_tool`, not `get_policy`). A typed handler map is listed as follow-up | — | **Partly fixed** |
| Q3 | Module placement: chat imports production wiring from `lib/voice/deps.ts`; `lib/rag` ↔ `lib/guardrails` import each other; UI reducer lives in the chat hook | Code review | n/a (structure) | Not moved (pure refactor, no behaviour change); documented in README "Known limitations" | — | **Open → known limitation** |
| Q4 | Untested critical paths: guardrail pipeline branch logic (only paid evals), stream-resume protocol, Postgres stores | Code review | n/a | Partly: Postgres ledger now has live integration tests (race + rejected-frees-invoice); session ownership unit-tested. Pipeline-branch and stream-resume unit tests remain | — | **Partly fixed** |

## Minor

| ID | Finding | Source | Status |
|---|---|---|---|
| S3 | Per-IP limits keyed on the left-most `X-Forwarded-For` (spoofable in principle) | Security (code reading) | **Not exploitable on Vercel:** live test with rotated `X-Forwarded-For`/`X-Real-IP` still hit 429 after the per-IP limit (the platform overwrites them). Hardened anyway: prefer `x-vercel-forwarded-for` / `x-real-ip`, else the right-most XFF hop. Global daily caps unchanged |
| M1 | `/api/health` ran 2 OpenAI calls + DB on every page load, unthrottled | Grader, code review | **Fixed:** cached 30 s per instance; the UI only fetches when "Backend health" is opened |
| M2 | Model-facing tool text ("It is safe to call issue_refund again…") shown in a customer step row | Grader | **Fixed:** customer-facing step summaries for failures |
| M3 | Unknown tool reported as `get_policy` in the log and trace | Code review | **Fixed** |
| M4 | Seven empty `lib/*/index.ts` stubs; unused `ChatMessage`/`MessageRole` shared types | Code review | **Fixed:** removed |
| M5 | `ensureSession` outside try in the chat route (raw 500 on DB error) | Code review | **Fixed:** session creation now happens in the authorized, try-wrapped path |
| M6 | Health exposes commit SHA, pgvector version, migration count | Security | Known limitation: no secrets; kept for deploy verification |
| M7 | Traces include the full system prompt | Security | By design (the drawer shows prompt traces); now visible only to the session's owner |
| M8 | Restored transcripts lose step indicators and totals after reload | Grader | Known limitation (the drawer keeps the full trace) |
| M9 | Drawer span order can swap instantaneous marks with the same millisecond | Grader | Known limitation |
| M10 | Typing disabled while voice is live; 3-minute voice cap; serial tool calls; sentence-gated streaming (first token after tools) | Grader | Decided design (D22, D26, D36); explained in README trade-offs |
| M11 | Client/server API types duplicated (report, voice session, transcript ticket as a string) and some string protocols (`FALLBACK`, span names) | Code review | Known limitation (follow-up: a shared `contracts.ts`) |
| M12 | `rateLimitedResponse` lacks `requestId`; a few `console.error` calls bypass the structured logger; `ModelError.transient` always true | Code review | Known limitation |
| M13 | Shared mutable demo state (refunds consumed by one reviewer affect the next) | Grader | Mitigated: 2–3 extra invoices per user, `npm run demo:reset` (developer-only) |
| M14 | No CI | Grader | **Fixed:** GitHub Actions workflow (typecheck, lint, unit tests, build) |

## Regressions found while fixing (and fixed)
- **G3's paraphrase pattern rewrote policy text.** The live scenario run after the fix showed a claim-gate correction on the happy path: "…plans can be refunded… up to $200" became "No refund has been issued yet." Reproduced with a test, then the pattern was narrowed to first-person or your-money subjects. Live scenarios afterwards: 6/6 with 0 corrections.
- **The agent eval's approval heuristic counted negated sentences.** "No refund has been issued" counted as an approval claim, which failed S5 falsely. Fixed, with a test.

**Final live scenario run (`npm run eval:agent -- gpt-5.4-mini`):** 6/6 pass, 0 claim-gate corrections, all policy violations blocked by code. CI (typecheck, lint, tests, build) green on GitHub Actions.

## Remaining open items and why
- **Q1, Q3 (structure):** refactors with no behaviour change. With the voice path verified live, splitting the voice hook and moving modules now has a higher regression risk than reviewer benefit. Both are listed in README "Known limitations".
- **Q2, Q4 (partly):** the concrete bugs behind them are fixed and the Postgres paths are now tested. A typed tool handler map and pure tests for the pipeline branches and stream resume are follow-ups.
- **Session ownership** is per browser (cookie), not per user; there are no user accounts in scope. Clearing cookies means losing access to old conversations.
