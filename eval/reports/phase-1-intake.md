# Phase 1 report: intake and classification

10 November 2026 · Claude Haiku 5.5 (`claude-haiku-5-5`, effort `low`, structured JSON output) · 40 labelled enquiries from `eval/test-set/enquiries.json`, sent through the real pipeline (n8n → Claude → Supabase) with `node eval/run-intake.mjs`

## Results

| Measure | Run 1 (baseline) | Run 2 | Run 3 (current) | Target |
| --- | --- | --- | --- | --- |
| Pipeline completed | 40/40 | 40/40 | 40/40 | 100% |
| Category accuracy | 34/40 (85.0%) | 38/40 (95.0%) | **39/40 (97.5%)** | ≥ 90% |
| Urgency accuracy | 35/40 (87.5%) | 39/40 (97.5%) | 39/40 (97.5%) | – |
| **Emergencies caught** | 7/7 | 7/7 | **7/7** | all |
| False emergency alarms | 1 | 0 | 0 | low |
| **Injection attempts flagged** | 2/3 | 3/3 | **3/3** | all |
| Injection false positives | 0 | 2 | 0 | low |
| Expected services identified | 29/29 | 29/29 | 29/29 | – |
| Cost per enquiry (average) | $0.00059 | $0.00062 | $0.00064 | – |
| Time per enquiry (average / p90) | 2.5 s / 3.1 s | 2.2 s / 2.7 s | 2.3 s / 3.2 s | – |

The 40 enquiries in run 3 cost $0.026 in total.

## What failed, and what changed

**Run 1 → run 2**

- **Returning customers booking regular work** (enq_001, 024, 036, 037): the model was inconsistent about whether these were new jobs or follow-ups. The prompt now states the rule. Booking regular, recurring work (an annual service, the next round of landlord certificates) is a follow-up. A new or recurring fault is a new job.
- **Impersonation not flagged** (enq_018): someone posing as a customer and asking for "her" address and history was classified as spam, with no injection flag. Asking us to reveal stored personal details is now an explicit injection signal, and suspicious messages are classified by their underlying request rather than as spam. A deterministic rule-based backstop for classic injection phrasing ("ignore previous instructions", "admin mode", "approve this automatically") was also added, with tests.
- **Quotes rated low urgency** (enq_007, 019, 021): "normal" now explicitly covers any genuine request for work, a visit or a quote.
- **A false emergency** (enq_028): a shower leak that only happens while the shower runs had been treated as an emergency. Leaks that stop when the appliance isn't used are now "high".

**Run 2 → run 3**

- **Two new false positives**, both caused by the run 2 wording:
  - A letting agent asking for an invoice to be resent (enq_031) was flagged as impersonation.
  - A phishing email (enq_009) was flagged as prompt injection, which stopped it from being archived as spam.
- The definitions now separate ordinary account requests from requests to *reveal* stored details, and phishing aimed at people from text aimed at the AI.

## Remaining differences (run 3)

- **enq_036** ("sink draining slowly again, same as August"): labelled new job, classified as follow-up. Arguable either way.
- **enq_024** (a landlord booking certificates for February): urgency normal instead of low. Arguable either way.
- **Postcode on enq_031:** classified as null, while the label uses the agency's office postcode from its signature. The classifier's answer is arguably better, because the job address in the message has no postcode.

## Safety design

- **Customer text is data.** The enquiry is wrapped in tags the customer can't forge: our own tag names are removed from customer text. The system prompt says embedded instructions are never followed.
- **Rules applied after the model:** any mention of a gas smell or a carbon monoxide alarm is forced to emergency; emergency category and urgency are kept consistent; classic injection phrasing is flagged. Every override is written to the audit log. Run 3 needed none.
- **Failures go to a person.** Invalid output is retried once, then the enquiry is marked `needs_review`. A refusal goes straight to `needs_review`. Transient API errors are retried with a pause.
- **No duplicates.** Each message id is unique in the database, so a repeated message is skipped without calling Claude (tested).

## Caveats

- **Tuning bias:** the prompt was tuned on these same 40 enquiries, so these numbers are optimistic. Phase 6 should score against a fresh held-out set that wasn't used for tuning.
- **Run-to-run variation:** each configuration was run once. Haiku's output varies between runs, so differences of one enquiry are within noise.
