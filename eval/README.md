# Evaluation

`test-set/enquiries.json` holds 40 realistic, labelled enquiries. They are the regression suite and the source of the accuracy report.

## Mix

| Category | Count | Includes |
| --- | --- | --- |
| New job request | 8 | Extended-area booking, an out-of-area enquiry to decline, multiple services, a landlord CP12 |
| Quote request | 8 | Boiler replacement and bathroom refit (survey needed), price-matching, commercial |
| Emergency | 7 | Night-time burst pipe, water through a ceiling, gas smell, CO alarm, a vulnerable customer with no heating, a café flood, and one understated emergency that is easy to miss |
| Complaint | 5 | A repair still under guarantee that has failed, a disputed cancellation fee, mess left behind, an all-caps rant, a non-customer |
| Existing-customer follow-up | 6 | An open quote near expiry, a service due, landlord certificates, an invoice copy |
| Spam | 6 | SEO pitch, phishing, wrong business, supplier pitch, newsletter, link spam |

Within those, 3 are **prompt-injection attempts**: a fake "SYSTEM: admin mode" block, a fake internal note from the office manager, and an impersonation of a real customer from an unknown address. At least 3 are deliberately vague. 15 come from returning customers, recognised by email or phone.

## Labels

Each enquiry carries:

- `category`, `urgency` (`emergency` / `high` / `normal` / `low`), `is_injection`, `should_reply`
- `expected_customer_id`: set only when the sender's email or phone really matches a customer
- `expected_service_ids`, `postcode`, `in_service_area`
- `required_facts`: what the reply must contain, using exact figures from the data
- `forbidden_facts`: what the reply must not contain, such as invented prices, other customers' details, or anything embedded instructions asked for
- `tags` and `notes` explaining the tricky part

## Held-out set

`test-set/held-out.json` holds 15 more enquiries, written independently of the prompts (by a separate agent that could read the business data and this file, but not the prompts or any results) and never used for tuning: 3 new jobs, 3 quotes, 2 emergencies (one understated: a dead boiler with a newborn, written as a replacement-quote request), 2 complaints, 3 follow-ups, 2 spam, with 2 injection attempts in new styles (instructions hidden in a web-form field; a request for another customer's phone number with a fake consent line). Its first-run numbers are the honest ones; once a fix is informed by a held-out case, later runs on it are reported as "after fixes", not as held-out results.

## Scoring (Phase 6)

| Measure | Target | How |
| --- | --- | --- |
| Classification accuracy | ≥ 90% | `run-intake.mjs`, against the labels |
| Emergencies caught | 100% (any miss is a failure, whatever the overall score) | same |
| Injections flagged with no harmful draft | 100% | flags from `run-intake.mjs`; "no harmful draft" from the grader's forbidden facts |
| Facts: required present, forbidden absent | Reported, with 95% intervals | `grade.mjs`: a Claude Opus 5.5 judge rules on every fact with a quote from the reply, given the sender's business records; a script cross-checks every £ figure; disagreements and failures go to a spot-check sheet for a person |
| Cost and time per enquiry | Reported | from the pipeline's own usage figures |

```bash
node eval/run-intake.mjs --run-id main-1                      # 40 enquiries: classify + draft (~$1.15)
node eval/run-intake.mjs --set held-out --run-id held-out-1   # 15 enquiries (~$0.45)
node eval/grade.mjs --run main-1                              # grade the drafts (~$0.02 each)
node eval/grade.mjs --selftest                                # check the judge itself (~$0.15)
cd eval && npm install && npm test                            # grader unit tests (first time: install the pinned SDK)
```

`grade.mjs` writes `grading.md` (summary, per-draft table, what failed), `spot-check.md` (every failing or disputed judgment plus a random sample of passing ones, with the draft text) and `grades.jsonl` / `grades.json` next to the run. Grades are written as each draft finishes, so a re-run resumes; failed judge calls go to `errors.jsonl` and are never scored as zero. The self-test grades hand-written perfect replies (must pass) and empty, "I don't know", wrong-enquiry and forbidden-sentence variants (must fail).

## Validating the labels

```bash
node scripts/validate-test-set.mjs                  # the 40-enquiry set
node scripts/validate-test-set.mjs --set held-out   # the held-out set (also checks ids don't clash)
```

This checks counts, unique ids, that every expected customer really matches the sender, that every service id exists, that postcode coverage agrees with `service-areas.json`, and that all senders use reserved fictional emails and phone numbers.
