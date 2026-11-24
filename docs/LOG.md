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
