# Evidence: what was measured, and how far it goes

Every rate is k/n with an exact 95% Clopper–Pearson interval ("CI"). Sets are small (9–40 items per table), so the intervals are wide: these numbers show behaviour, not tight error bounds. Sources live in `evals/`; `npm run eval:evidence` recomputes the guardrail tables from the stored per-query decisions.

## Guardrails: what each layer actually does

| Layer | What it does | Evidence |
|---|---|---|
| **Similarity pre-filter** (top-1 cosine ≥ 0.28) | Screens clearly out-of-domain questions before any LLM call | **Not a calibrated boundary:** the full guardrail's results are flat from 0.10 to 0.44 on the calibration split. 0.28 is the midpoint of that range, chosen from the score distributions. It caught the 8 out-of-domain blind items |
| **Answer model abstains** (`NOT_COVERED`) | Declines when the retrieved text doesn't answer the question | Caught **all 8 blind near-miss questions**. Across all 20 blind should-escalate items: abstention 11, pre-filter 8, grounding gate 1 |
| **Grounding gate** | Citations must be in the retrieved set; `gpt-5.4-nano` checks each claim against the cited chunks; unsupported side details are trimmed | Its sanity set (9/9) used hand-written drafts. **Its value on real drafts isn't measured separately**: it caught 1 blind item |
| **Confidence level** (HIGH / MEDIUM / LOW) | **HIGH** = grounded, untrimmed, top-1 ≥ 0.45 and doc-level margin ≥ 0.10. MEDIUM is answered with a hedge; LOW escalates | Thresholds chosen on the calibration split only (every should-escalate item there had a doc margin ≤ 0.094). Validation below |

## Blind held-out results (v1 held-out 10 + v2 30)

Latest stored runs (v2 re-run 2026-11-25), current labelling rule:

| Items | False escalations | Missed escalations |
|---|---|---|
| All 40 | 1/20 (5%, CI 0–25%) | **0/20** (0%, CI 0–17%) |
| Hard: near-miss, tier-specific, approval demands, injections (23) | 1/11 (9%, CI 0–41%) | 0/12 (0%, CI 0–26%) |
| Ordinary in-scope (9) | 0/9 (0%, CI 0–34%) | — |
| Out-of-domain (8) | — | 0/8 (0%, CI 0–37%) |

**Run-to-run variation.** The answer model isn't deterministic. v2 false escalations over four runs: 1/15, 1/15, 2/15, 1/15, with different items each time: v09, v10 and v11 have each flipped. Missed escalations have been 0/15 in every run. The previous evidence write-up used the 2/15 run (blind FE 2/20).

## Labelling convention (and its effect)

One rule for every set (`evals/LABELING.md`): a query that **only** demands an approval ("approve my $900 refund") is should_escalate, because the refund tool or a person decides, not the policy answer. **The rule was adopted after the original results had been seen.** It changes two v1 items (q27, q30), which were the only false escalations in the original v1 results, so it improves the v1 numbers. `evals/RESULTS.md` reports every table under both rules. Under the original labels the blind 40 give FE 2/21 (CI 1–30%) and ME 0/19 (CI 0–18%).

## Harder held-out set (v3, 18 items)

Written and committed before any run: adjacent numbers, wrong-tier questions, partial coverage, approval demands (`evals/HARDER_SET.md`).

| Run | False escalations | Missed escalations | Misses |
|---|---|---|---|
| First (labelled for correctness) | 1/9 (CI 0–48%) | 3/9 (CI 7–70%) | h03, h12 (approval demands answered with accurate policy text), h17 (partly covered, answered with "the documents don't say") |
| Re-run 2026-11-25 (scoring only) | 1/9 (CI 0–48%) | 5/9 (CI 21–86%) | the same three plus h07 (export 40 days after expiry, partly covered) and h13 (approval demand) |

In the agent, a refund request goes to `issue_refund`, which decides in code. So an approval demand answered by the policy lookup can't move money, but the guardrail eval still counts it as a miss. **Hard items are where the guardrail is weakest.**

## Confidence level vs answer correctness

Answers labelled correct or wrong against the cited documents (`evals/CONFIDENCE.md`, `evals/HARDER_SET.md`):

| Level | Blind 40 | Harder 18 | Pooled |
|---|---|---|---|
| HIGH answered correctly | 14/14 | 6/7 | **20/21** (CI 76–100%) |
| MEDIUM answered correctly | 5/6 | 2/4 | 7/10 (CI 35–93%) |
| LOW: escalation was right | 19/20 | 6/7 | 25/27 (CI 76–99%) |

HIGH's point estimate is higher than MEDIUM's (95% vs 70%), but the intervals overlap, so **it isn't shown that HIGH is more accurate than MEDIUM** at these sample sizes.

**Who labelled.** Answer correctness was labelled by the coding assistant against the cited documents. A separate AI annotator re-labelled a random 10 blind: its factual verdicts matched all 10 once the customer's tier was supplied, and one item differs only under the approval-demand labelling rule. Both annotators are AI, so this is a consistency check, not human validation (`evals/BLIND_RELABEL.md`).

## Agent reliability (live model, scripted customers)

- **7 multi-turn chat scenarios** (`npm run eval:agent`, `evals/AGENT_RESULTS.md`): happy path, over-limit, expired contract, failed identity, injection, already refunded, wrong invoice.
- On commit `c585c0d`: **35/35 runs** (CI 90–100%), pass^5 for 7/7 scenarios (CI 59–100%).
- After the unverified own-plan change (2026-11-25), 7 × 3 runs:
  - **First run: 19/21.** S2 failed because a crashing final-grounding check failed the whole turn; now fixed: the check fails safe. S5 failed because an extra policy lookup on the injection message escalated and opened a P3 ticket. Nothing was refunded.
  - **After the fix: 20/21** (CI 76–100%), pass^3 for 6/7 scenarios (CI 42–100%). S1 run 1 falsely escalated the verified "refund limit and window" question and opened a ticket: the same answer-model variation as in the held-out runs.
  - **Final code** (third-person own-plan matching, repeated-sentence collapse): **20/21** (CI 76–100%), pass^3 6/7. The same S1 false escalation recurred: 2 of the last 6 S1 runs, after 8/8 earlier on 2026-11-24. A recurring false escalation on a verified policy question; not yet fixed.
- **Action-claim check:** 20/20 on a labelled set of replies, against 11/20 for the regex alone (`evals/ACTION_CLAIMS.md`).

## What the evidence does and doesn't show

**Shows:**
- No missed escalation on 20 blind should-escalate items, across every run.
- The answer model abstaining is what catches near-misses.
- Policy rules hold in code (limits, windows, contract status, invoice ownership and matching, refund only on request). Each is unit-tested and was refused live.
- The chat scenarios pass repeatedly.

**Doesn't show:**
- **Tight error rates:** the sets are small.
- **The grounding checker's value on real drafts:** it caught 1 blind item.
- **That HIGH is more accurate than MEDIUM:** the intervals overlap.
- **Robustness on harder items:** 3–5 of 9 missed escalations on the harder set, mostly approval demands.
- **Independent labels:** both labellers are AI; there is no human-labelled set.
- **Real-microphone voice quality:** voice checks used synthetic clips played into the microphone track.

## What breaks first at 100× traffic

| What breaks | Why | Cheapest mitigation |
|---|---|---|
| Global daily caps | Each is one hot Postgres row; a few IPs can exhaust the demo for everyone (caps raised for the review window, DECISIONS D76) | Shard the counter or move it to Redis/Upstash; per-IP limits first |
| OpenAI rate limits | One key, so 429 storms; retries amplify them | A token bucket per model, a queue with backpressure, an early "busy" reply |
| Neon load | Stream-resume polling, the session log re-read per agent step, sequential queries per turn | Keep the log in memory during a turn; push resume events instead of polling; batch trace writes |
| Voice cost | The 3-minute cap is enforced in the browser | Move the SDP exchange to the server and hang up at the cap |
