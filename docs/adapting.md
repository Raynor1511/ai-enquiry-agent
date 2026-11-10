# Adapting this for your business

The agent is built so that the business-specific parts sit in data, prompts and two small interfaces. The pipeline, the safety checks, the approval flow and the evaluation stay as they are. A typical adaptation for a small service business takes a few days, most of it spent on the test set and on connecting the existing systems.

## 1. Your business data

| What | Where | Notes |
| --- | --- | --- |
| Services and prices | `seed/data/services.json` | Each service has a price basis (`fixed`, `range` or `from`), a note, and keywords. Drafts may only quote prices that come from here; a check flags anything else |
| Policies | `seed/data/policies.json` | Call-out fees, emergencies, cancellations, guarantees, payment, complaints, privacy: the drafting model quotes these, so the wording matters |
| Service area | `seed/data/service-areas.json` | Postcode districts per zone, travel charges, emergency response targets |
| Business details and tone | `seed/data/business.json` | Name, hours, team, and the tone-of-voice rules the drafts follow |
| Customers and job history | `seed/data/customers.json`, `jobs.json` | For a real business these come from its own system instead (next section) |

`node scripts/build-seed-sql.mjs` turns the JSON into SQL, and `node scripts/db-setup.mjs` loads it and sets up the database roles.

## 2. Your existing systems

- **Customer records (CRM, job management).** The MCP server reads customers, jobs, services and policies through one interface, `BusinessDataStore` in `mcp-server/src/data/types.ts` (nine methods). There are two implementations: JSON files and Postgres. A third one that calls the business's CRM (HubSpot, Jobber, ServiceM8, a spreadsheet) keeps the four tools, their identity checks and their tests unchanged. Keep it read-only.
- **Calendar.** Availability comes from `CalendarProvider` in `mcp-server/src/calendar/types.ts` (busy times plus the working-hours template in `seed/data/calendar.json`). Google Calendar is built in; Outlook or a booking system is another provider.
- **Inbox.** The Gmail trigger and send nodes are in `n8n/build.mjs` (Intake and Slack interactions). For Outlook, swap them for n8n's Microsoft Outlook nodes; the rest of the pipeline only sees the normalised enquiry (`n8n/src/lib/normalise.mjs`).
- **Web form.** The n8n form can be replaced by a webhook from the business's own website form; map its fields in `normalise.mjs`.
- **Approval.** Slack cards with Approve / Edit / Reject. Teams would need its own card and interaction handling; the approval logic (`n8n/src/lib/approval.mjs`) is independent of Slack's message format except for the card builders.

## 3. The prompts

- `n8n/src/prompts/classify-system.md`: the categories, what counts as an emergency for this business, and the urgency levels. Emergencies also have fixed rules in code (`applySafetyRules` in `n8n/src/lib/classification.mjs`) that the model can't override; add the business's own non-negotiables there.
- `n8n/src/prompts/draft-system.md`: what a good reply does for each category, and the tool rules. Keep the grounding rules (prices and facts only from the tools).

Run `node n8n/build.mjs` and `node n8n/deploy.mjs` after any change.

## 4. Prove it before going live

1. **Write a test set from the business's real enquiries** (anonymised): 30 to 50 messages covering their usual mix, plus the awkward ones (emergencies written casually, angry complaints, people asking about other customers). Label each one in the format of `eval/test-set/enquiries.json`: the category, the urgency, and the facts a good reply must and must not contain, taken from their price list and policies. `node scripts/validate-test-set.mjs` checks the labels against the data.
2. **Keep a held-out set** of 10 to 15 that are never used while tuning the prompts, and report those numbers as the honest ones.
3. **Set targets first** (for example: at least 90% correct categories, every emergency caught, every injection attempt blocked), then run `eval/run-intake.mjs` and `eval/grade.mjs` and read the failures, not just the scores. See `eval/reports/phase-6-evaluation.md` for what that looks like.

## 5. Hosting and running costs

- **Hosting.** Move n8n from a PC and tunnel to n8n Cloud or a small VPS in the UK or EU with a real domain, keep Supabase in an EU region, and point the Slack app and the web form at the new address. The MCP server runs as a small container next to n8n.
- **Running costs.** About $0.034 per enquiry in API calls (classification with Claude Haiku 5.5 well under a cent, the draft with Claude Sonnet 5.5 about 3 cents), and about 14 seconds from arrival to an approval card. Spam costs a fraction of a cent and is never drafted. Set a spending limit in the Anthropic console; the public form is rate-limited.
- **Data protection.** Everything runs in the business's own accounts. Before going live, go through `docs/data-protection.md`: processors and their agreements, retention, and the deletion procedure (`scripts/clear-test-data.mjs` handles erasure requests and retention clean-ups).
