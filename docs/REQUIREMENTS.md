# Requirements checklist

Source: BRIEF.md. Rubric weights: **A** Agentic architecture & tools 35% · **V** Voice & real-time UX 25% · **C** Code quality & system design 25% · **P** Production readiness 15%.

Demo kinds: **test** (unit/integration test in repo) · **eval** (scored script over a labeled set) · **UI** (visible UI state) · **Loom** (moment in the walkthrough video).

Live URL: https://customer-support-agent-sable-two.vercel.app

Status: `[ ]` not started · `[~]` in progress · `[x]` done and demonstrated.

## 1. Dual-interface UI

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 1.1 | Streaming chat UI in React/Next.js over SSE | V | 25% | UI: tokens stream in; test: SSE event parser | [x] app/api/chat SSE, numbered typed events; tokens stream sentence by sentence through the claim gate |
| 1.2 | Real-time step status indicators ("Searching Knowledge Base…", "Verifying Account Tier…") driven by `step_started` / `step_completed` events | V/A | 25%/35% | UI: step chips appear and resolve live; Loom | [x] step_started/step_completed rendered live (spinner → ✓/✕, summary, duration) |
| 1.3 | Live voice toggle using a multimodal streaming API (OpenAI Realtime over WebRTC) | V | 25% | UI: toggle connects; Loom: live conversation | [ ] |
| 1.4 | Active audio waveform feedback (mic + agent) | V | 25% | UI: waveform/level meter moves with speech; Loom | [ ] |
| 1.5 | Live transcripts of both sides in voice mode | V | 25% | UI: transcript lines appear while speaking; Loom | [ ] |
| 1.6 | Interruption handling (barge-in cancels agent audio) | V | 25% | Loom: interrupt mid-answer, agent stops and responds; UI: "interrupted" marker | [ ] |
| 1.7 | Collapsible observability drawer: prompt traces | P/C | 15%/25% | UI: drawer lists trace spans with prompt/tool I/O | [ ] |
| 1.8 | Drawer: end-to-end latency metrics (per step + total, TTFT) | P | 15% | UI: latency numbers per turn | [~] trace spans record per-step latency (lib/observability/trace.ts); UI later |
| 1.9 | Drawer: token usage | P | 15% | UI: in/out tokens per turn and session | [~] trace spans record tokens; UI later |
| 1.10 | Drawer: estimated API cost | P | 15% | UI: $ per turn and session; test: cost calculator | [~] trace spans estimate cost from lib/config.ts prices; UI later |

## 2. RAG & grounding engine

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 2.1 | Node.js backend connected to a vector DB (Neon pgvector) | C | 25% | /api/health checks DB; test: retrieval query | [x] Neon pgvector 0.8.7; lib/rag/retrieve.ts cosine top-k; live tests pass |
| 2.2 | Custom document chunking over sample support policies | A/C | 35%/25% | test: chunker on fixtures; README explains choice | [x] lib/rag/chunker.ts section-aware, 52 chunks; tests/chunker.test.ts; D13 |
| 2.3 | Sample support policy corpus (refunds, tiers, troubleshooting) | A | 35% | files in repo; ingest script output | [x] data/policies: 11 docs (incl. 1 poisoned) + data/mock_users.json (6 users) |
| 2.4 | Explicit similarity threshold, calibrated on a labeled eval set | A | 35% | eval: precision/recall at chosen threshold printed | [x] t=0.28 by stated rule on calibration split; evals/RESULTS.md |
| 2.5 | Secondary verification: grounding check (answer must cite retrieved chunks) | A | 35% | eval: ungrounded answers caught; test: citation validator | [x] citation check + gpt-5.4-nano claim check; sanity set 9/9 |
| 2.6 | Out-of-scope / low-confidence queries route to a human escalation state | A | 35% | eval: out-of-scope set → escalation rate; UI: escalation banner; Loom | [x] typed GuardrailDecision; escalation event + UI card (suggested / ticket) |
| 2.7 | Retrieved documents treated as data, never instructions | A/P | 35% | eval/test: injected-instruction doc doesn't change behaviour | [x] quarantine + data framing; 0/30 replies approve a refund; evals/RESULTS.md poison section |

## 3. Autonomous multi-step tool orchestration

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 3.1 | Autonomous reasoning loop (custom typed state machine) | A/C | 35%/25% | test: state transitions; trace in drawer | [x] lib/agent/machine.ts typed transitions, traced; tests/agent.test.ts |
| 3.2 | Chains ≥3 mock tools in one turn | A | 35% | Loom + trace: verify → retrieve → act in one turn | [x] verify → get_policy → issue_refund in one turn (scripted test + live S1) |
| 3.3 | Tool: verify mock identity, subscription tier, contract status | A | 35% | test: unverified/expired/suspended cases | [x] verify_identity: email + PIN, same error for unknown/wrong, lock + P1 ticket after 3 |
| 3.4 | Tool: retrieve policy/troubleshooting docs filtered by tier | A | 35% | test: tier filter excludes other tiers' docs | [x] get_policy: guarded retrieval with the verified tier (general-only when unverified) |
| 3.5 | Tool: simulated action (mock refund within policy limits / account update / escalation ticket) | A | 35% | test: over-limit refund refused; idempotency key dedupes | [x] issue_refund (write-ahead ledger, idempotent) + create_escalation_ticket (DB, idempotent) |
| 3.6 | Policy enforced in tool code (refund limits, tier, identity, contract) not prompts | A/P | 35%/15% | test: tool refuses even when LLM asks | [x] lib/tools/policy.ts; 16 tool tests; live S2/S3/S5/S6 refusals by code |
| 3.7 | Stream live status when a tool starts/completes | V/A | 25%/35% | UI: step chips; SSE event log | [x] SSE step events per tool |
| 3.8 | Voice tool calls go through the same backend tool + guardrail endpoint | A/C | 35%/25% | Loom: voice refund shows in same trace drawer; test: endpoint | [ ] |
| 3.9 | Routing (tool choice / escalation decision) has a measurable eval | A | 35% | eval: routing accuracy over labeled turns | [~] 6 live scenarios per model in evals/AGENT_RESULTS.md (tool chain + violations + false claims) |

## 4. Resilience & state

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 4.1 | Graceful fallback UI on upstream LLM timeout | P | 15% | UI: retry/fallback message; test: timeout path | [~] ModelError → typed error event + graceful reply + Retry button; tested with a scripted model; fault toggle in phase 4 |
| 4.2 | Graceful fallback on LLM rate limit (429) | P | 15% | UI: rate-limit banner with retry; test | [~] 429 from OpenAI → llm_rate_limited event; tested; UI banner + retry |
| 4.3 | Graceful handling of simulated tool failure mid-conversation | P/A | 15%/35% | UI: failed step chip + recovery; Loom (fault-injection toggle) | [~] TOOL_FAILURE typed error, never a false success (ledger-failure test); fault injection toggle in phase 4 |
| 4.4 | Consistent multi-turn session memory across text and voice | A/V | 35%/25% | Loom: switch chat→voice, agent remembers; DB rows share session_id | [~] append-only session_events, context rebuilt per turn; voice joins in phase 4 |
| 4.5 | Rate limiting on our own API | P | 15% | test/curl: 429 after N requests; UI message | [x] Postgres fixed-window limits: rag answer 10/10 min/IP + 200/day, chat 30/10 min/IP + 600/day; 429 verified live |
| 4.6 | Deployment stability | P | 15% | live URL; /api/health ok | [~] live; /api/health 200 ok on Vercel prod (2026-11-23) |

## 5. Code quality

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 5.1 | Modular separation: UI / agent / tools / vector store (lib/agent, lib/tools, lib/rag, lib/guardrails, lib/voice, lib/observability, lib/session, lib/db) | C | 25% | repo layout; README diagram | [~] |
| 5.2 | Clean typing: TS strict, shared types in lib/types.ts, typed SSE events | C | 25% | `npm run typecheck` passes | [~] |
| 5.3 | No secrets in git or browser; ephemeral voice tokens | P | 15% | .env.example; network tab shows only ephemeral key | [~] |

## 6. Deliverables

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 6.1 | Public GitHub repo with full source | C | 25% | repo URL | [x] github.com/akshara-ns/customer-support-agent (public) |
| 6.2 | `.env.example` | P | 15% | file in repo | [x] |
| 6.3 | README: architecture, chunking choices, key trade-offs | C/P | 25%/15% | README.md (trade-offs from DECISIONS.md) | [ ] |
| 6.4 | Live demo link (Vercel) | P | 15% | URL | [x] https://customer-support-agent-sable-two.vercel.app |
| 6.5 | Loom 3–5 min: live chat, voice incl. interruption, multi-step tools, RAG + guardrail walkthrough, clear communication | V/P | 25%/15% | Loom link in README | [ ] |
