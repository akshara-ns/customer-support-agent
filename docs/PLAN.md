# Plan (12-hour hard limit)

| Hours | Block |
|---|---|
| 0–1 | Scaffold + deploy |
| 1–3 | RAG + guardrail + eval |
| 3–5 | Agent loop + 3 tools + SSE chat |
| 5–7 | Voice |
| 7–8.5 | Resilience + rate limit + observability drawer |
| 8.5–9.5 | Reviews + fixes |
| 9.5–10.5 | README + final deploy |
| 10.5–11.5 | Loom |
| 11.5–12 | Buffer |

## Cut rules (apply in this order if behind)
1. Eval set 30 → 20 items.
2. Fancy waveform → simple level meter.
3. Drawer polish last.

Any block that runs over is reported immediately (see CLAUDE.md).

## Time log
| Block | Planned | Started | Ended | Notes |
|---|---|---|---|---|
| 0–1 Scaffold + deploy | 60 min | 2026-11-23 19:13 | 2026-11-23 19:32 | ~20 min wall clock; on time |
| 1–3 RAG + guardrail + eval | 120 min | 2026-11-23 19:38 | 2026-11-23 20:03 | on time; deployed and verified live |
| 3–5 Agent loop + tools + SSE chat | 120 min | 2026-11-23 20:06 | 2026-11-23 20:31 | on time; first items took ~5 min (not over, as I first misreported) |
| 5–7 Voice | 120 min | 2026-11-23 20:36 | 2026-11-23 21:13 | on time; no cut rule needed |
| 7–8.5 Resilience + rate limit + observability drawer | 90 min | 2026-11-23 21:25 | 2026-11-23 21:48 | on time; nothing cut (stream resume and p50/p95 included) |
| 8.5–9.5 Reviews + fixes | 60 min | 2026-11-23 21:48 | 2026-11-23 22:10 | on time; README also written here (closes the only critical finding) |
| Phase 7 Code structure + stronger evidence | 90 min | 2026-11-23 22:11 | 2026-11-23 22:52 | on time; voice split kept (live checks passed), nothing reverted |
| Phase 10A Senior-review fixes | 75 min | 2026-11-24 00:16 | 2026-11-24 00:47 | on time; item 9 partly (region pinned, in-memory log not done) |
| Phase 9 Final fixes, then freeze | 60 min | 2026-11-23 23:47 | 2026-11-24 00:14 | on time; regressions found by the scenario runs fixed or documented |
| Phase 8 Grader deductions | 75 min | 2026-11-23 22:55 | 2026-11-23 23:26 | on time; item 5 (server-enforced voice limits) left as a documented limitation with options |
