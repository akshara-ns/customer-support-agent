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
| Q1 | `useVoice.ts` is a 627-line hook mixing transport, event handling, interruption and the tool bridge, with ~13 casts on untyped realtime events | Code review, grader | n/a (structure) | Phase 7: split into `transport.ts` (session key, SDP, history replay, teardown), `audio.ts`, `realtimeEvents.ts`, `toolBridge.ts`, `interruption.ts`, `transcript.ts`, `types.ts`; the hook (304 lines) keeps React state and lifecycle. 7 new unit tests (`tests/voice-client.test.ts`) cover barge-in, tool-call de-duplication, dropped half-streamed calls and the unreachable-server fallback | Suite 109 → 116; all 8 VOICE_CHECKS re-run live on the deployed split (2026-11-24, see VOICE_CHECKS.md) | **Fixed (Phase 7)** |
| Q2 | Tool results typed `unknown` force casts downstream; `parsed.data as …` casts in the registry | Code review | n/a (typing) | Phase 7: `lib/contracts.ts` defines `ToolOutcome`, a discriminated union by tool name (`ToolResult<ToolOutputs[K]>`), used by the registry (typed handler map, one documented cast), the session log, the voice bridge and the UI. Stored ledger JSON is validated, not cast | Typecheck clean; casts removed in step/events | **Fixed (Phase 7)** |
| Q3 | Module placement: chat imports production wiring from `lib/voice/deps.ts`; `lib/rag` ↔ `lib/guardrails` import each other; UI reducer lives in the chat hook | Code review | n/a (structure) | Phase 7: layers ui → routes → server → orchestration (agent, voice) → tools → guardrails → rag → infra. Moved: wiring to `lib/server/deps.ts`, tool step to `lib/tools/step.ts`, claim gate to `lib/guardrails/claims.ts`, prompt framing and injection scan to `lib/rag`, UI reducer to `components/agentEvents.ts` | `tests/architecture.test.ts` (no upward imports, no top-level cycles; verified by injecting a violation) and an ESLint `no-restricted-imports` rule for `components/**` | **Fixed (Phase 7)** |
| Q4 | Untested critical paths: guardrail pipeline branch logic (only paid evals), stream-resume protocol, Postgres stores | Code review | n/a | Phase 6: Postgres ledger integration tests. Phase 7: pipeline dependencies injectable → `tests/pipeline.test.ts` (10 tests, every branch, no API cost); SSE parsing and de-dup extracted to `components/sse.ts` → `tests/stream-resume.test.ts` (5 tests incl. the resume route with mocked log/ownership) | Suite green | **Fixed (Phase 7)** |

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
| M8 | Restored transcripts lose step indicators and totals after reload | Grader | **Fixed (Phase 7)** for step indicators and ticket cards: `lib/server/transcript.ts` rebuilds each turn's steps from the session log (2 tests; verified live for chat and voice). Per-turn totals still only in the drawer |
| M9 | Drawer span order can swap instantaneous marks with the same millisecond | Grader | Known limitation |
| M10 | Typing disabled while voice is live; 3-minute voice cap; serial tool calls; sentence-gated streaming (first token after tools) | Grader | Decided design (D22, D26, D36); explained in README trade-offs |
| M11 | Client/server API types duplicated (report, voice session, transcript ticket as a string) and some string protocols (`FALLBACK`, span names) | Code review | **Fixed (Phase 7)** for API payloads: one client-safe `lib/contracts.ts` (tool outcomes, voice session/tool responses, transcript lines with typed ticket, trace report). Span names remain strings |
| M12 | `rateLimitedResponse` lacks `requestId`; a few `console.error` calls bypass the structured logger; `ModelError.transient` always true | Code review | Known limitation |
| M13 | Shared mutable demo state (refunds consumed by one reviewer affect the next) | Grader | Mitigated: 2–3 extra invoices per user, `npm run demo:reset` (developer-only) |
| M14 | No CI | Grader | **Fixed:** GitHub Actions workflow (typecheck, lint, unit tests, build) |

## Regressions found while fixing (and fixed)
- **G3's paraphrase pattern rewrote policy text.** The live scenario run after the fix showed a claim-gate correction on the happy path: "…plans can be refunded… up to $200" became "No refund has been issued yet." Reproduced with a test, then the pattern was narrowed to first-person or your-money subjects. Live scenarios afterwards: 6/6 with 0 corrections.
- **The agent eval's approval heuristic counted negated sentences.** "No refund has been issued" counted as an approval claim, which failed S5 falsely. Fixed, with a test.

**Final live scenario run (`npm run eval:agent -- gpt-5.4-mini`):** 6/6 pass, 0 claim-gate corrections, all policy violations blocked by code. CI (typecheck, lint, tests, build) green on GitHub Actions.

## Remaining open items and why
- **Q1–Q4, M8, M11** were closed in Phase 7 (2026-11-24) with no behaviour change: full suite before (109) and after (116), typecheck/lint/build, CI green, and the voice and chat checks re-run live on the deployed build.
- **New in the Phase 7 live re-check:** the voice model refused a $900 refund from policy text in 3/3 tries instead of calling `issue_refund` (in Phase 4 it called the tool; Phase 7 didn't change the prompt, but Phase 6 added "General questions that don't need the account go straight to get_policy", a likely cause). The refusal and escalation were correct and no refund can bypass the tool, but the tool-decides chain wasn't exercised by voice. Listed in README "Known limitations".
- **M12** (logging nits) and span names as strings remain.
- **Session ownership** is per browser (cookie), not per user; there are no user accounts in scope. Clearing cookies means losing access to old conversations.

## Phase 8: the grader's re-run deductions (2026-11-24)

The grader re-ran after Phase 7 and scored about 80/100. Each item below was reproduced first, then fixed, tested, deployed (`670a399`) and re-verified live.

| # | Deduction | Reproduced by | Fix | Verified | Status |
|---|---|---|---|---|---|
| P8-1 | A pending ledger entry left by an exception locks the invoice forever (`REFUND_IN_PROGRESS`) | `tests/ledger-expiry.test.ts` failed (3/4) before the fix | Pending entries expire after 2 min and are resolved by the next request; own key resumes (D51) | 4 unit tests and a live-Postgres test. **Live:** `tool_failure` on a $29 refund (04:14:23 UTC). Another session refunded the same invoice at 04:16:38. Ledger: one `REQUEST_EXPIRED`, one `succeeded` | **Fixed** |
| P8-2 | Regex claim gate misses paraphrases ("Your refund is complete") | Labelled set: regex 11/20 | Model extraction plus code comparison as layer 2; chat corrects before release, voice flags (D52) | 20/20 on the set; 6 gate/runTurn tests; chat scenarios 6/6 with 0 false corrections | **Fixed** |
| P8-3 | One unsupported side claim escalates a correct answer | — (grader's live case) | Partial grounding (D53) | 2 pipeline tests; v2 held-out unchanged (FE 1/15, ME 0/15). The grader's exact case (an SSO part of the question was unsupported) still escalates, because that claim answered the question, as the rule requires | **Fixed (by rule)** |
| P8-4 | Voice refuses over-limit refunds without calling `issue_refund` | Live 0/3 in Phase 7 | Refund requests take precedence in the prompt and tool descriptions (D54) | **Live voice 3/3** called the tool (refused by code); chat scenarios 6/6 | **Fixed** |
| P8-5 | Voice limits (cap, usage, `session.update`) are client-side | Docs: sideband and hangup exist, but the server never sees the call_id | Not changed; limitation documented precisely, with options (D55) | — | **Open: user decision** |
| P8-6 | No listening / thinking / speaking indicator | — | Indicator derived from call state | The first live check found it stuck on "Thinking…" (playback spans the tool call). Fixed, then verified live: Listening → Thinking → Speaking → Thinking → Speaking → Listening | **Fixed** |
| P8-7 | `/api/rag/search` unthrottled without `answer=1` | — | Limited in all modes (D56) | 2 route tests; live: 429 on the 31st call in the window | **Fixed** |
| P8-8 | Contradictory eligibility wording | Phase 7 live chat | Prompt rule for listing refundable invoices | Prompt only; not separately measured | **Mitigated** |

Also found while doing this: the scenario runner's `--repeat` parsing (Phase 7) dropped the model name when `--repeat` was absent. Fixed in its own commit.

## Phase 9: final fixes before the feature freeze (2026-11-23/24)

| # | Item | Reproduced by | Fix | Verified | Status |
|---|---|---|---|---|---|
| P9-1 | Low-confidence escalation wasn't a state (turn `completed`, suggestion only) | `tests/escalation-state.test.ts`, 4/4 failing first | D57 | 4 tests (chat verified and unverified, model handoff line, voice bridge). **Live:** unverified out-of-scope → card with reason and confidence 0.18, drawer `responding → escalated`. Voice get_policy escalation → ESC-1012 (P3) with card | **Fixed** |
| P9-2 | `/api/rag/search` bypassed the tier gate and returned traces | 3 new tests failing on the old route | D58; `ADMIN_KEY` set in Vercel (production and preview) and `.env.local` | 5 route tests | **Fixed** |
| P9-3 | Unverified tier questions escalated | Real-stack script: "Pro refund window" → `answer_declined` | D59 | 5 tests. **Live:** "What is the refund window and per-request refund limit on the Pro plan?" (unverified) → "Depends on your plan: verification needed" and a request for email and PIN | **Fixed** |
| P9-4 | Grader: get_policy skipped on a policy question after a ticket turn (session 659dd4bc) | **Reported, not reproduced.** Read the session from the prod log: turn 2 combined "Yes please" with a policy question, and turn 3 repeated it. Replayed those exact three messages through the real model and policy search 3 times on the current prompt (0 skips) and 3 times on the Phase 8 prompt the grader ran (0 refusals; 2 runs answered turn 3 from that conversation's earlier tool results without a new lookup). A variant with separate turns: 3 runs, 0 skips | None | — | **Not reproduced** |
| P9-5 | Slow first text on tool turns | Measured 5.5–7.1 s on a 3-tool turn | D60 | 0.57–0.79 s (3 runs); live 0.7–0.9 s; 3 tests | **Fixed** |

**Regressions found by the scenario runs this phase, and what was done:**
- **S6 (already refunded) went 0/3.** The Phase 8 eligibility prompt rule made the model refuse from invoice data. A/B: 3/3 without the rule, 1/3 with it. The rule was removed, and the acknowledgment kept out of the model's context.
- **S5 (injection) issued an unrequested $174 refund in 1 of 3 runs.** The customer had only sent credentials. Fixed in code (D61), with 3 tests.
- **S4 (failed identity) at 1/3.** The A/B points at the Phase 8 refund-routing wording (D54). Kept for voice, documented; safe miss (no access granted).
- A text-spacing bug ("now.Pro") between model steps was fixed, with a test.

**Final scenario run (3 per scenario):** S1–S3, S5, S6 3/3; S4 1/3 (16/18).

**Still open at the freeze:**
- Escalation for off-topic requests depends on the model calling get_policy (seen live: one decline without a tool, one direct ticket in a session with earlier handoffs).
- S4 at 1/3.
- Voice limits are client-side (D55, the user's decision: keep documented).
- No Loom yet.

## Phase 10A: findings from both independent reviews and their status (2026-11-24)

### Senior-engineer review

| # | Finding | Reproduced by | Fix | Status |
|---|---|---|---|---|
| SR-1 | Stale authorization: refunds used the verification snapshot | `tests/fresh-authorization.test.ts`, 2 of 3 failing first | D62 | **Fixed** |
| SR-2 | No end-to-end turn deadline; SDK retries under ours | Hung model, tool and ledger tests (unbounded before) | D63; 3 tests | **Fixed** |
| SR-3 | Final text not grounded | — (design) | D64; 6 tests; live: no-tool off-topic and policy turns | **Fixed** |
| SR-4 | Voice tool-call race; interrupted calls without outputs | New tests failing on the old client | D65; 4 tests | **Fixed** (unit-tested; live voice chain re-checked) |
| SR-5 | Lockout abusable per account | New tests | D66; 3 tests incl. live Postgres | **Fixed** |
| SR-6 | Tickets deduped by reason only | `tests/ticket-dedupe.test.ts`, 1 of 3 failing first | D68 | **Fixed** |
| SR-7 | Claim check too broad, no timeout | — | D69; 3 tests | **Fixed** |
| SR-8 | Browser transcripts stored as trusted, arrival order | — | D70; 2 tests | **Fixed** |
| SR-9 | DB round trips per turn; region | — | Region pinned to `iad1` (already there, so no TTFT change); in-memory session log not done | **Partly** |

### Grader re-run after Phase 8 (about 79/100)

| Finding | Status |
|---|---|
| No Loom walkthrough | **Open** (to record) |
| Agent skipped get_policy after a ticket turn | Not reproduced (P9-4). Now covered in code: no-tool replies with unsupported claims go through the guardrail (D64) |
| Unverified tier questions escalated | **Fixed** (P9-3, D59) |
| `/api/rag/search` bypassed the tier gate | **Fixed** (P9-2, D58) |
| Low confidence was a suggestion, not a state | **Fixed** (P9-1, D57); card shows the guardrail reason (P10A item 11) |
| Voice caps client-side | Documented, the user's decision (D55) |
| Slow first text | **Fixed** (P9-5, D60): 0.5–0.9 s live |
| Tool spans `ok` when the tool returned an error; voice spans 0 ms; e2e includes caller speech | **Open** (observability polish) |
| Code hygiene: stale comment `bridge.ts:3`, deprecated alias, duplicated serializers, `ModelError.transient`, duplicate imports | **Open** |
| Public fault injection; global daily caps shared by all | Accepted for a public demo (documented) |

### Phase 9 open items folded in
- **Off-topic escalation without get_policy:** fixed by D64. Live: "recommend a stock" → ESC-1015, card "no relevant policy found · 0.18"; "tax return" → ESC-1016, card "our documentation doesn't cover this · 0.43".
- **Escalation card reason:** fixed. Shows the guardrail's reason, not the ticket category.
- **S4 1/3:** fixed in code (D67), now 3/3.

**Problems found while doing this:**
- The first final-grounding version escalated tool turns on harmless paraphrases (scenarios 12/18); narrowed.
- The live check found the handoff trimmed away its own ticket number; fixed, with a test.
- v2 held-out re-run: FE 2/15, ME 0/15. One flip (v11, Free "version history", `answer_declined`). Over three runs v11 escalated twice: answer-model variance, not an API error from the retry change.

## Before Phase 10B: three follow-ups (2026-11-24)

| # | Item | Reproduced by | Fix | Status |
|---|---|---|---|---|
| A | Wrong-invoice refund (asked about inv_2001, model refunded inv_2002) | `tests/invoice-match.test.ts`, 4 failing first | D71; 7 tests; scenario S7 (5/5) | **Fixed** (voice: mismatch only, against transcripts logged so far) |
| B | Tool spans "ok" on tool errors; voice spans 0 ms | Tests failing first | Error spans carry the error code; realtime responses and the claim check record real durations | **Fixed** |
| C | Stale comment, deprecated alias, duplicated serializer, `ModelError.transient` | — | Tidied, no behaviour change (suite unchanged) | **Fixed** |

Phase 10B evidence work: labelling convention (D74), intervals everywhere (`eval:evidence`), attribution corrected (D73), 3-level confidence validated (D75; HIGH vs MEDIUM not separated at 95%), harder set v3 run once (FE 1/9, ME 3/9), scenarios 35/35 with pass^5 7/7 on frozen code.

