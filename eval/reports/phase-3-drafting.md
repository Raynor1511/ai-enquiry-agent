# Phase 3 report: drafting

10 November 2026 · Claude Sonnet 5.5 (`claude-sonnet-5-5`, effort `medium`, structured JSON draft, server-side fallback) · tools from the Harbourline MCP server · 40 labelled enquiries through the real pipeline (`node eval/run-intake.mjs`)

## Full run (all 40 enquiries)

| Measure | Result |
| --- | --- |
| Drafts produced for enquiries needing a reply | 34/34 |
| Spam correctly not drafted | 6/6 |
| Drafting failures | 0 |
| Price check passed (every £ figure retrieved or derived) | 33/34 |
| Contact check passed (no one else's email or phone) | 34/34 |
| Verified customer matches the label | 34/34 |
| Flagged for human review | 21/34 |
| Turns per draft (average) | 4.2 |
| Cost per draft | average $0.041, total $1.39 |
| Time per draft | average 14.2 s, p90 17.7 s |

Every draft was read by hand, including the safety-critical cases:

- **Gas smell and carbon monoxide** (enq_015, enq_033): safety steps and 0800 111 999 come first. The drafts state that we can't attend until the supply has been made safe. The CO draft adds medical advice for the symptoms described.
- **Vulnerable customer** (enq_010): the customer was recognised by email, treated as a priority, and given the 2-hour target.
- **Understated emergency** (enq_020): the customer says "no rush", but it is answered as an emergency, with the extended-area 3-hour target and travel charge.
- **Injection attempts and impersonation** (enq_007, enq_018, enq_032): nothing disclosed, no discounts, embedded instructions ignored, and each one flagged.
- **Disputes and guarantee claims** (enq_006, enq_022, enq_028, enq_036): no refunds or free work promised. Each is passed to the office manager, citing the guarantee where it applies.

## Problems found and fixed

| Problem | Fix |
| --- | --- |
| Test enquiries carry fixed dates (9–20 Nov) while slot searches start from today, so the model kept re-searching | Test enquiries are drafted as if they arrived now. Classification still sees the real date |
| Repeated lookups: identical `get_services` calls, single-day slot probes, up to 6 turns | The prompt says every price lookup already returns all policies. Repeated identical calls are marked as repeats. Each set of tool results ends with a short reminder to answer once the facts are in |
| False alarm in the price check for "3 × £280–£450 = £840–£1,350" | The check accepts multiples (×2–×10) of retrieved figures, and percentages the tools state (a 25% deposit) |
| The model avoided stating a deposit in pounds because the figure wasn't in a tool result | The prompt allows simple arithmetic on retrieved figures, with the working shown in `prices_quoted` |
| A complaint from a non-customer left out the 10-working-day target | The complaint guidance applies to everyone and always includes the target |
| Over-flagging ("please send quickly") | `needs_human_review` is reserved for decisions the reviewer must make. Suggestions go in the reasoning |
| The runaway tool loop in the first smoke test | The last allowed turn sets `tool_choice: none`, so the model must answer |

## After the fixes (the 12 most affected enquiries)

| Measure | Before | After |
| --- | --- | --- |
| Price check passed | 11/12 | 12/12 |
| Flagged for review | 8/12 | 3/12 |
| Turns (average) | 5.0 | 2.2 |
| Cost per draft | $0.043 | $0.033 |
| Time per draft | 15.1 s | 10.4 s |

With fewer turns, a few drafts now ask when suits the customer instead of offering slots. Phase 6's grader will measure whether that costs anything against the required facts.

## Live checks

- **Web form emergency** ("strong smell of gas", BS6):
  - classified as an emergency in 1.9 s, and the alert posted to **#alerts** about 3 s after submission
  - holding reply drafted in 9.7 s for $0.028, with both checks passed

## Caveats

- **Tuning bias:** prompts were tuned on these 40 enquiries, so a held-out set is needed for honest numbers (Phase 6).
- **What the checks cover:** they catch invented prices and leaked contact details. Tone, completeness and the label's required and forbidden facts will be scored by a Claude grader in Phase 6, with human spot checks.
