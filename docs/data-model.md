# Data model

The JSON files in `seed/data/` are the single source of truth for the demo business. `scripts/build-seed-sql.mjs` turns them into `seed/sql/002_seed.sql`, so the JSON and the database never drift apart.

## Seed data

| File | Contents |
| --- | --- |
| `business.json` | Name, contact details, hours, team, tone-of-voice rules for drafting |
| `services.json` | 19 services with fixed, range or "from" prices, notes, keywords for matching, and whether a survey is needed |
| `policies.json` | 14 policies: fees, emergencies, gas and CO safety, hours, area, cancellations, guarantees, quotes, payment, landlords, installs, bathrooms, complaints, privacy |
| `service-areas.json` | Bristol postcode districts: core BS1–BS16 (no travel charge, 2-hour emergency target); extended (£25 travel, 3-hour target). Everything else is not covered |
| `customers.json` | 30 fictional customers: residential, landlord, letting agent, commercial |
| `jobs.json` | 48 past jobs, including an open quote, a repair still under guarantee, and a late-cancellation fee |
| `calendar.json` | Appointment windows, lead time, bank holidays, and two weeks of bookings relative to today |

## Database (Postgres / Supabase)

| Table | Written by | Read by MCP server |
| --- | --- | --- |
| `services`, `policies`, `service_area_districts` | Seed script and admin | Yes |
| `customers`, `jobs` | Seed script, then n8n after approval | Yes |
| `enquiries` | n8n. `message_id` is unique, so no message is processed twice | No |
| `drafts` | n8n: draft text, reasoning, tools used, confidence, price grounding check | No |
| `approvals` | n8n: approve, edit or reject, who decided, and the final text | No |
| `audit_log` | n8n: every step, with model, tokens, cost and timing | No |

Row-level security is on for every table. On Supabase that blocks the public API keys entirely. Each part of the system has its own database role (`003_roles.sql`), and the admin user is only used by setup scripts:

| Role | Used by | Can | Cannot |
| --- | --- | --- | --- |
| `mcp_readonly` | MCP server | `SELECT` the five reference tables | Write anything, or see enquiries, drafts, approvals, audit |
| `n8n_writer` | n8n | Read what the workflows read; add enquiries, drafts, approvals, customers, jobs, audit rows; change an enquiry's status, classification and customer link, and a draft's Slack location | Delete or truncate anything; rewrite a customer's message, a draft's text or an approval; change the audit log or read its details (it may read only which event happened when); read policies or the service area; create or alter tables |
| admin (`postgres`) | `scripts/db-setup.mjs`, cleanup scripts | Everything | (never given to a running service) |

`n8n_writer` also has a 30-second statement timeout, so a stuck query can't hold locks. `scripts/db-setup.mjs` proves both roles: it replays every query the n8n workflows run as `n8n_writer` (inside a transaction that is rolled back) and checks that the forbidden statements are refused; a unit test makes sure every Postgres node's query is in that list.

## Loading into Supabase

The easy way is `node scripts/db-setup.mjs` (see [setup](setup.md)). By hand:

1. In the Supabase SQL editor, run `seed/sql/001_schema.sql`, then `002_seed.sql`, then `003_roles.sql`. All three are safe to re-run.
2. Give both roles a password (choose your own, and don't commit them):
   `alter role mcp_readonly with login password '...';` and `alter role n8n_writer with login password '...';`
3. Set the MCP server's `DATABASE_URL` to the pooler connection string with the user `mcp_readonly.<project-ref>`, and set `DATA_SOURCE=postgres`. Set `N8N_DB_URL` the same way with `n8n_writer.<project-ref>`; n8n's Postgres credential is built from it.

After editing any JSON file, regenerate the SQL with `node scripts/build-seed-sql.mjs` and re-run `002_seed.sql`.
