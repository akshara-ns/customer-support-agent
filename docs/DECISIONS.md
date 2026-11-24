# Decisions

Each entry: decision · reason · main alternative rejected. These feed the README's trade-offs section.

| # | Decision | Reason | Main alternative rejected |
|---|---|---|---|
| D1 | One Next.js app (App Router, TypeScript strict) on Vercel; API routes are the Node backend | One deploy, one type system shared by UI and backend, no CORS; fits a 12-hour budget | Separate FastAPI backend + Next.js frontend (two deploys, duplicated types) |
| D2 | Modules `lib/agent`, `lib/tools`, `lib/rag`, `lib/guardrails`, `lib/voice`, `lib/observability`, `lib/session`, `lib/db`; shared types in `lib/types.ts`; UI in `app/` + `components/` | Clear boundaries between UI, orchestrator, tools and vector store, which the rubric grades directly | Feature-folder layout mixing UI and backend code per feature |
| D3 | Neon Postgres + pgvector for sessions, messages, traces and embeddings | One managed store for relational state and vectors; serverless driver works on Vercel; joins between chunks and metadata (tier) are plain SQL | Pinecone/Qdrant for vectors + separate DB for state (two services, two consistency stories) |
| D4 | Custom typed state machine for the agent loop | Every state and transition is explicit, typed and testable; easy to emit step events and to force an escalation state | LangGraph/Mastra (more abstraction to learn and debug inside the time budget) |
| D5 | SSE for chat with typed events `step_started`, `step_completed`, `token`, `error`, `trace`, `done` | One-way server→client stream is all chat needs; works over plain HTTP on Vercel serverless | WebSockets (need a stateful server, not supported by Vercel functions) |
| D6 | Voice via OpenAI Realtime API over WebRTC; backend issues ephemeral tokens | Lowest-latency speech-to-speech with built-in VAD and barge-in; browser never sees the real API key | STT → LLM → TTS pipeline (higher latency, interruption handling built by hand) |
| D7 | Voice tool calls go to the same backend tool/guardrail endpoint as chat; voice transcripts saved into the same session | One policy and guardrail path for both modes; consistent multi-turn memory across modes | Defining tools client-side for voice (duplicate logic, policy bypass risk) |
| D8 | Guardrail = similarity threshold calibrated on a labeled eval set + grounding check (answer must cite retrieved chunks); low confidence → escalation state | Threshold is measured, not guessed; citation check catches answers not backed by retrieved text | Prompt-only "say I don't know if unsure" (not measurable, not enforceable) |
| D9 | Policy (refund limits, tier, identity, contract status) enforced in tool code; refund tool idempotent | The LLM cannot talk its way past a rule; retries never double-refund | Policy rules in the system prompt only |
| D10 | Retrieved documents are wrapped and treated as data, never as instructions | Prevents prompt injection through the knowledge base | Trusting corpus text inline in the system prompt |
| D11 | Raw SQL migrations in `db/migrations/*.sql` applied by a small Node script using `@neondatabase/serverless` | No ORM to learn or configure; schema is readable; pgvector types need raw SQL anyway | Drizzle/Prisma (extra setup and codegen, weak pgvector support) |
| D12 | Embedding size 1536 (`text-embedding-3-small`) | Cheap, good quality, same provider as Realtime so one API key | `text-embedding-3-large` (3072 dims, higher cost, marginal gain on a small corpus) |
