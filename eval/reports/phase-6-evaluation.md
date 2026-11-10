# Phase 6: evaluation report

Every enquiry ran through the real pipeline in test mode (the n8n workflows, Claude Haiku 5.5 classification, Claude Sonnet 5.5 drafting with the MCP tools over the Supabase data), stopping before Slack and email. Two sets: the **main set** of 40 labelled enquiries, which the prompts were tuned on, and a **held-out set** of 15 written independently of the prompts and never used for tuning (`eval/README.md`). Each draft was graded against its labelled required and forbidden facts by a Claude Opus 5.5 judge that quotes the reply as evidence, cross-checked by a script on every £ figure (`eval/grade.mjs`). Runs of 10 November 2026.

## Results

| Measure | Target | Main, first run | **Held-out, first run** | Main, after fixes |
| --- | --- | --- | --- | --- |
| Category accuracy | ≥ 90% | 97.5% (39/40) | **80.0% (12/15)** ✗ | 100% (40/40) |
| Emergencies caught | all | 7/7 | **1/2** ✗ | 7/7 |
| False emergency alarms | few | 0 | 0 | 0 |
| Injection attempts flagged | all | 3/3 | 2/2 | 3/3 |
| Injection attempts with no harmful draft | all | 3/3 | 2/2 | 3/3 |
| Harmless false injection flags | few | 0 | 1 | 0 |
| Drafts produced where a reply is needed | all | 34/34 | 13/13 | 34/34 |
| **Drafts with every required fact and no forbidden one** | report | 85% (29/34; 70–94%) | **85% (11/13; 58–96%)** | **97% (33/34; 85–99%)** |
| Required facts present | report | 95.7% (111/116) | 95.0% (38/40) | 99.1% (115/116) |
| Drafts containing any forbidden fact | 0 | 0 | 0 | 0 |
| Cost per enquiry (classify + draft) | report | $0.0006 + $0.032 | $0.0006 + $0.032 | $0.0006 + $0.033 |
| Time per enquiry (classify / draft, average) | report | 2.3 s / 10.2 s | 2.2 s / 10.5 s | 2.4 s / 11.7 s |

Ranges are 95% intervals: with sets this small, a difference of one or two drafts is noise. The held-out first run is the honest estimate of how the agent handles enquiries it has never seen; the right-hand column shows the main set after the fixes below.

## What failed and what changed

1. **A missed emergency (held-out).** A dead boiler with a three-week-old baby at home, written as a request for a replacement quote, was classed as a high-urgency quote. The classifier had every fact (vulnerable occupant, no heating or hot water) but reasoned that the family was coping with a plug-in heater. The business's policy has no such exception, so it is now a fixed rule, like the existing gas and carbon-monoxide rules: no heating or hot water plus a vulnerable occupant is always an emergency. The prompt now defines the flag as a *total* loss and says coping doesn't change it. Replayed over six earlier runs, the rule fires only on real emergencies; re-run, the case is caught.
2. **Fixed prices described as estimates.** "A fixed £95 … the final price is confirmed on inspection", and one reply that called the £95 service "a guide figure" and left the price out. The tool description and the drafting prompt both told the model that *all* prices are guides; both now say fixed prices are fixed.
3. **Incomplete answers.** Policies quoted only in part (the £40 late-cancellation fee without the free 24-hour window) and replies that told customers to turn off the stopcock when they already had. The drafting prompt now asks for the parts of a policy that apply in full, and to acknowledge what the customer has already done.

After the fixes the main set went from 29 to 33 of 34 drafts with every fact, with nothing worse elsewhere. The two held-out cases behind fixes 1 and 3 pass on a re-run; because they informed the fixes they are no longer blind, so the held-out first run stays the headline. Still open: one draft gives "June 2025" for a service the record dates to 12 June 2025 and calls it "due" rather than overdue; borderline replies that hedge a guarantee ("if it's down to our workmanship") are marked as missing it; and the pipeline's price check doesn't recognise a balance (£8,400 − £2,100 = £6,300) as derived, so it sends that draft to a person (the safe direction).

## Checking the checker

- **Self-test:** the judge passed two hand-written perfect replies and failed every bad variant (forbidden sentence added, empty, "I don't know", a reply to a different enquiry): 10/10, for both judge versions.
- **Bugs in the eval, fixed before the numbers above:** the judge couldn't see the business records, so it marked a correct mention of a customer's past repair as invented; one held-out label assumed free appointment slots that the live calendar didn't have. The judge now gets the sender's records, the label was corrected, and every first-run number above was re-graded with the corrected judge.
- **Consistency:** the same 10 drafts graded twice with identical input gave identical results (61/61 fact verdicts, 10/10 pass/fail). Between the two judge versions, 206 of 208 verdicts matched; the two that moved were hedged wording, the judge's only soft spot.
- **Script cross-check:** one disagreement, where a fact allowed "£120 or £200" and the script can't read "or"; the judge was right.
- **Spot-check:** every failing verdict and a random sample of passing ones (with their quotes) were read against the drafts: all verdicts agreed with, three of them strict but defensible. This was done by the AI assistant building the project, at the owner's request, not by an independent person; the sheets are in each run's `spot-check.md` for a human pass.

## Limitations

The sets are small and synthetic: the main set shaped the prompts, and the held-out set was written by a separate AI agent from the business data rather than taken from real customers. The judge reads strictly (exact figures and dates, no credit for conditional wording). Phase 6 cost about $5.85 in API calls: $2.79 for the pipeline runs and $3.06 for the judge, including re-grading after the grader fix.
