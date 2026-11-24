# Requirements checklist

Source: BRIEF.md. Rubric weights: **A** Agentic architecture & tools 35% · **V** Voice & real-time UX 25% · **C** Code quality & system design 25% · **P** Production readiness 15%.

Demo kinds: **test** (unit/integration test in repo) · **eval** (scored script over a labeled set) · **UI** (visible UI state) · **Loom** (moment in the walkthrough video).

Status: `[ ]` not started · `[~]` in progress · `[x]` done and demonstrated.

## 1. Dual-interface UI

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 1.1 | Streaming chat UI in React/Next.js over SSE | V | 25% | UI: tokens stream in; test: SSE event parser | [ ] |
| 1.2 | Real-time step status indicators ("Searching Knowledge Base…", "Verifying Account Tier…") driven by `step_started` / `step_completed` events | V/A | 25%/35% | UI: step chips appear and resolve live; Loom | [ ] |
| 1.3 | Live voice toggle using a multimodal streaming API (OpenAI Realtime over WebRTC) | V | 25% | UI: toggle connects; Loom: live conversation | [ ] |
| 1.4 | Active audio waveform feedback (mic + agent) | V | 25% | UI: waveform/level meter moves with speech; Loom | [ ] |
| 1.5 | Live transcripts of both sides in voice mode | V | 25% | UI: transcript lines appear while speaking; Loom | [ ] |
| 1.6 | Interruption handling (barge-in cancels agent audio) | V | 25% | Loom: interrupt mid-answer, agent stops and responds; UI: "interrupted" marker | [ ] |
| 1.7 | Collapsible observability drawer: prompt traces | P/C | 15%/25% | UI: drawer lists trace spans with prompt/tool I/O | [ ] |
| 1.8 | Drawer: end-to-end latency metrics (per step + total, TTFT) | P | 15% | UI: latency numbers per turn | [ ] |
| 1.9 | Drawer: token usage | P | 15% | UI: in/out tokens per turn and session | [ ] |
| 1.10 | Drawer: estimated API cost | P | 15% | UI: $ per turn and session; test: cost calculator | [ ] |

## 2. RAG & grounding engine

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 2.1 | Node.js backend connected to a vector DB (Neon pgvector) | C | 25% | /api/health checks DB; test: retrieval query | [~] |
| 2.2 | Custom document chunking over sample support policies | A/C | 35%/25% | test: chunker on fixtures; README explains choice | [ ] |
| 2.3 | Sample support policy corpus (refunds, tiers, troubleshooting) | A | 35% | files in repo; ingest script output | [ ] |
| 2.4 | Explicit similarity threshold, calibrated on a labeled eval set | A | 35% | eval: precision/recall at chosen threshold printed | [ ] |
| 2.5 | Secondary verification: grounding check (answer must cite retrieved chunks) | A | 35% | eval: ungrounded answers caught; test: citation validator | [ ] |
| 2.6 | Out-of-scope / low-confidence queries route to a human escalation state | A | 35% | eval: out-of-scope set → escalation rate; UI: escalation banner; Loom | [ ] |
| 2.7 | Retrieved documents treated as data, never instructions | A/P | 35% | eval/test: injected-instruction doc doesn't change behaviour | [ ] |

## 3. Autonomous multi-step tool orchestration

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 3.1 | Autonomous reasoning loop (custom typed state machine) | A/C | 35%/25% | test: state transitions; trace in drawer | [ ] |
| 3.2 | Chains ≥3 mock tools in one turn | A | 35% | Loom + trace: verify → retrieve → act in one turn | [ ] |
| 3.3 | Tool: verify mock identity, subscription tier, contract status | A | 35% | test: unverified/expired/suspended cases | [ ] |
| 3.4 | Tool: retrieve policy/troubleshooting docs filtered by tier | A | 35% | test: tier filter excludes other tiers' docs | [ ] |
| 3.5 | Tool: simulated action (mock refund within policy limits / account update / escalation ticket) | A | 35% | test: over-limit refund refused; idempotency key dedupes | [ ] |
| 3.6 | Policy enforced in tool code (refund limits, tier, identity, contract) not prompts | A/P | 35%/15% | test: tool refuses even when LLM asks | [ ] |
| 3.7 | Stream live status when a tool starts/completes | V/A | 25%/35% | UI: step chips; SSE event log | [ ] |
| 3.8 | Voice tool calls go through the same backend tool + guardrail endpoint | A/C | 35%/25% | Loom: voice refund shows in same trace drawer; test: endpoint | [ ] |
| 3.9 | Routing (tool choice / escalation decision) has a measurable eval | A | 35% | eval: routing accuracy over labeled turns | [ ] |

## 4. Resilience & state

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 4.1 | Graceful fallback UI on upstream LLM timeout | P | 15% | UI: retry/fallback message; test: timeout path | [ ] |
| 4.2 | Graceful fallback on LLM rate limit (429) | P | 15% | UI: rate-limit banner with retry; test | [ ] |
| 4.3 | Graceful handling of simulated tool failure mid-conversation | P/A | 15%/35% | UI: failed step chip + recovery; Loom (fault-injection toggle) | [ ] |
| 4.4 | Consistent multi-turn session memory across text and voice | A/V | 35%/25% | Loom: switch chat→voice, agent remembers; DB rows share session_id | [ ] |
| 4.5 | Rate limiting on our own API | P | 15% | test/curl: 429 after N requests; UI message | [ ] |
| 4.6 | Deployment stability | P | 15% | live URL; /api/health ok | [~] |

## 5. Code quality

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 5.1 | Modular separation: UI / agent / tools / vector store (lib/agent, lib/tools, lib/rag, lib/guardrails, lib/voice, lib/observability, lib/session, lib/db) | C | 25% | repo layout; README diagram | [~] |
| 5.2 | Clean typing: TS strict, shared types in lib/types.ts, typed SSE events | C | 25% | `npm run typecheck` passes | [~] |
| 5.3 | No secrets in git or browser; ephemeral voice tokens | P | 15% | .env.example; network tab shows only ephemeral key | [~] |

## 6. Deliverables

| # | Requirement | Cat | Wt | How we demonstrate it | Status |
|---|---|---|---|---|---|
| 6.1 | Public GitHub repo with full source | C | 25% | repo URL | [ ] |
| 6.2 | `.env.example` | P | 15% | file in repo | [~] |
| 6.3 | README: architecture, chunking choices, key trade-offs | C/P | 25%/15% | README.md (trade-offs from DECISIONS.md) | [ ] |
| 6.4 | Live demo link (Vercel) | P | 15% | URL | [ ] |
| 6.5 | Loom 3–5 min: live chat, voice incl. interruption, multi-step tools, RAG + guardrail walkthrough, clear communication | V/P | 25%/15% | Loom link in README | [ ] |
