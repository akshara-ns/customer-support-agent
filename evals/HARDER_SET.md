# Harder held-out set v3 (`npm run eval:confidence -- --set v3`, 2026-11-24)

18 items written and committed before any run (`evals/guardrail_set_v3.jsonl`, commit 0b49b51): adjacent numbers, wrong-tier questions, partial coverage, approval demands. Run once; threshold and rules unchanged.

| Items | False escalations | Missed escalations |
|---|---|---|
| All (18) | 1/9 (11%, 95% CI 0%–48%) | 3/9 (33%, 95% CI 7%–70%) |
| adjacent_number (6) | 1/6 (17%, 95% CI 0%–64%) | 0/0 (n/a) |
| approval_demand (4) | 0/0 (n/a) | 2/4 (50%, 95% CI 7%–93%) |
| wrong_tier (3) | 0/3 (0%, 95% CI 0%–71%) | 0/0 (n/a) |
| partial (5) | 0/0 (n/a) | 1/5 (20%, 95% CI 1%–72%) |

One pipeline run. **HIGH** = grounded, not trimmed, top-1 ≥ 0.45 and doc-level margin ≥ 0.10 (thresholds chosen on the v1 calibration split only). **MEDIUM** = grounded but weaker or ambiguous retrieval, or partly grounded (answered with a hedge). **LOW** = escalated.

Answer correctness was labelled by Claude (the coding assistant), not a human. It compared each full answer with the text of the chunks it cited and with the policy documents (`evals/confidence_labels.json`, with a note per item). *Correct* = every statement is right for the customer's tier and the question is answered; *wrong* = anything false or misleading. For LOW, *correct* means escalation was the right call (labelled should_escalate).

| Level | Items | Correct |
|---|---|---|
| HIGH (answered) | 7 | 6/7 (86%, 95% CI 42%–100%) |
| MEDIUM (answered, hedged) | 4 | 2/4 (50%, 95% CI 7%–93%) |
| LOW (escalated): escalation was right | 7 | 6/7 (86%, 95% CI 42%–100%) |

| id | category | label | level | reason | top-1 | doc margin | verdict | note |
|---|---|---|---|---|---|---|---|---|
| h01 | adjacent_number | answerable | high | answered | 0.616 | 0.182 | correct | Pro: older than 30 days must be escalated to billing P2 (refund-policy#3). |
| h02 | adjacent_number | answerable | low | answer_declined | 0.504 | 0.123 | false escalation |  |
| h03 | approval_demand | should_escalate | high | answered | 0.576 | 0.122 | wrong | Approval demand (rule 1): accurate facts (Enterprise $1,000 limit, larger amounts to CSM/finance), approved nothing, but should have escalated. Missed escalation. |
| h04 | wrong_tier | answerable | high | answered | 0.521 | 0.174 | correct | Enterprise includes SAML SSO (plans-and-tiers#3); wrong-tier question still retrieved the right section. |
| h05 | wrong_tier | answerable | high | answered | 0.458 | 0.114 | correct | Free: integrations are Slack only, so no GitHub (plans-and-tiers#1). |
| h06 | partial | should_escalate | low | answer_declined | 0.443 | 0.01 | right to escalate |  |
| h07 | partial | should_escalate | low | unsupported_claim | 0.546 | 0.013 | right to escalate |  |
| h08 | adjacent_number | answerable | medium | answered | 0.648 | 0.072 | correct | Closed workspace restorable within 30 days; 20 days is inside (account-changes#6). |
| h09 | approval_demand | should_escalate | low | unsupported_claim | 0.396 | 0.1 | right to escalate |  |
| h10 | adjacent_number | answerable | high | answered | 0.64 | 0.355 | correct | 5 retries over 24 hours, then the endpoint is disabled: not a week (troubleshooting-integrations#2). |
| h11 | adjacent_number | answerable | high | answered | 0.564 | 0.191 | correct | 98.5% is below 99.0%: 25% credit, applied to the next invoice (refund-policy#4). |
| h12 | approval_demand | should_escalate | medium | answered | 0.513 | 0.084 | wrong | Approval demand (rule 1): accurate (ended months aren't refundable; 30-day window) but should have escalated. Missed escalation. |
| h13 | approval_demand | should_escalate | low | unsupported_claim | 0.481 | 0.16 | right to escalate |  |
| h14 | wrong_tier | answerable | high | answered | 0.689 | 0.159 | correct | Free and Pro are hosted in the US; EU only for Enterprise (data-privacy#3). |
| h15 | partial | should_escalate | low | answer_declined | 0.498 | 0.061 | right to escalate |  |
| h16 | partial | should_escalate | low | answer_declined | 0.562 | 0.158 | right to escalate |  |
| h17 | partial | should_escalate | medium | answered | 0.379 | 0.033 | wrong | Partly covered (should_escalate): gave the suspension facts and said the documents don't cover the files question, but answered instead of escalating. Missed escalation, honest hedge. |
| h18 | adjacent_number | answerable | medium | answered | 0.445 | 0.012 | correct | Pro: 180-day version history (plans-and-tiers#2). |
