# Blind re-label of answer correctness (consistency check)

The answer-correctness labels in `CONFIDENCE.md` and `HARDER_SET.md` (`confidence_labels.json`, `confidence_labels_v3.json`) were written by the coding assistant against the cited documents. To check their consistency, a **separate AI agent** re-labelled a random sample of 10 answered items **blind**.

- **Sample:** 10 items drawn at random with seed `20261124`: h01, h03, h08, h10, q14, v03, v05, v06, v10, v26.
- **What the blind annotator saw:** only the question, the answer and the cited policy text.
- **What it did not see:** the original labels, the customer's tier, or the labelling rule (`LABELING.md`).

## Verdicts

| id | Original label | Blind verdict | Outcome | Reason |
|---|---|---|---|---|
| h01 | correct | CORRECT | Agreed | Agreed outright |
| h03 | wrong | CORRECT | **Differs** | The answer's facts are accurate. The original label is *wrong* only because of the approval-demand rule (`LABELING.md` rule 1: an approval-only request should escalate), which the blind annotator wasn't given |
| h08 | correct | CORRECT | Agreed | Agreed outright |
| h10 | correct | CORRECT | Agreed | Agreed outright |
| q14 | correct | UNCERTAIN; conditionally CORRECT | Agreed once the tier is given | The tier wasn't shown. Its conditional verdict was CORRECT under the tier recorded in the eval set (Enterprise), matching the original label |
| v03 | correct | CORRECT | Agreed | Agreed outright |
| v05 | correct | CORRECT | Agreed | Agreed outright |
| v06 | correct | CORRECT | Agreed | Agreed outright |
| v10 | correct | UNCERTAIN; conditionally CORRECT | Agreed once the tier is given | The tier wasn't shown. Its conditional verdict was CORRECT under the tier recorded in the eval set (Pro), matching the original label |
| v26 | correct | CORRECT | Agreed | Agreed outright |

## Summary
- **Factual verdicts matched on 10/10** once the customer's tier was supplied: 7 agreed outright, and 2 were conditionally correct under the recorded tier.
- **One item (h03) differs** only under the approval-demand labelling rule, not on the facts.
- **Both annotators are AI.** This is a consistency check between two AI labellers, **not human validation**. Independent human labels remain an open item (README, "What the evidence does and doesn't show").
