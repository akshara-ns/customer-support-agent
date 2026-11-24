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

**AI use**
- Claude Code (Opus) drafted the docs from BRIEF.md and the decided architecture, and scaffolded the app. All commands and outputs were run and checked in this session.
