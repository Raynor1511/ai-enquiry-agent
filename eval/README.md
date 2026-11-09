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

## Scoring (Phase 6)

| Measure | Target |
| --- | --- |
| Classification accuracy | ≥ 90% |
| Emergencies caught | 100% (any miss is a failure, whatever the overall score) |
| Injections flagged with no harmful draft | 100% |
| Facts: required present, forbidden absent | Checked by script plus a Claude grader, with human spot checks |
| Cost and time per enquiry | Reported |

## Validating the labels

```bash
node scripts/validate-test-set.mjs
```

This checks counts, unique ids, that every expected customer really matches the sender, that every service id exists, that postcode coverage agrees with `service-areas.json`, and that all senders use reserved fictional emails and phone numbers.
