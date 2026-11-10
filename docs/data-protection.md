# Data protection

Harbourline Plumbing & Heating is a **fictional** company and this is a portfolio demo. The seed customers use reserved `example.*` email domains and Ofcom's drama phone numbers; the only real personal data the system has handled is the developer's own test messages. These notes describe what a real deployment for a UK business would store, where, for how long, and how to delete it. They are a technical starting point for the business's own UK GDPR records, not legal advice.

## What is stored where

| Place | What personal data | Notes |
| --- | --- | --- |
| **Supabase** (Postgres, EU region eu-west-1) | `enquiries`: sender name, email, phone, subject, message, form fields. `drafts`: draft replies. `approvals`: the text actually sent, who approved it (Slack name and user id). `customers` / `jobs`: records created when a reply is approved. `audit_log`: every step, with model, tokens and cost; the drafting entry includes the tool results Claude saw (cut to 2,000 characters each), which can include a matched customer's details and job history | The main store. Row-level security on every table; each service has its own role (below) |
| **Gmail** (the business mailbox) | Incoming enquiry emails; replies sent | Google's account terms apply. For a client, use Google Workspace (which comes with a data processing agreement), not a consumer account |
| **Google Calendar** | Tentative holds: service, customer name, postcode district, enquiry reference (no email or phone) | Released automatically after 3 days unless confirmed |
| **Slack** | Approval cards (summary, sender name and email, message excerpt, draft); alerts in #alerts (emergencies with contact details, failed steps with sender and subject, Spam-folder matches with sender and excerpt); reminders and notes in threads | Visible to everyone in the workspace: keep it to staff. Customer text is escaped, so it can't ping channels or show fake links |
| **Anthropic** (Claude API) | For classification: the enquiry with the sender's name, email and phone. For drafting: the same, plus what the MCP tools return (services, prices, free slots, and a matched customer's details and job history) | Processed to produce the classification and draft; see Anthropic's commercial terms and privacy policy for retention. Their API terms don't use this data for model training by default |
| **n8n** (Docker volume on the host) | Execution history: each run's inputs and outputs, so enquiry text, drafts and Claude's responses | Deleted after 14 days (`EXECUTIONS_DATA_PRUNE` / `EXECUTIONS_DATA_MAX_AGE` in `docker-compose.yml`). Credentials are encrypted with `N8N_ENCRYPTION_KEY` |
| **ngrok** | Web form submissions and Slack requests pass through its edge (TLS terminated there) | Only the form and webhooks are reachable; ngrok's terms apply to traffic it relays |
| **MCP server** | Nothing stored. It reads reference data and calendar availability; its logs record which tool ran and the argument *names*, never values | Read-only database role and read-only calendar scope |

Nothing is ever emailed to a customer without a person approving it in Slack.

## Who can access what

| Who / what | Access |
| --- | --- |
| n8n | Database role `n8n_writer`: inserts and limited updates only. It can't delete or truncate anything, rewrite a customer's message, a draft or an approval, change the audit log or read its details, or alter tables ([roles](data-model.md#database-postgres--supabase)). Gmail: read, label, send (no permanent delete). Calendar: events only |
| MCP server | Database role `mcp_readonly`: `SELECT` on services, policies, service area, customers and jobs (it can't see enquiries, drafts or the audit log). Calendar: a service account; the server only ever asks Google for a read-only token (the same account can edit events when the setup scripts seed or clean the demo calendar) |
| Setup scripts | The admin connection (`SUPABASE_DB_URL`), only on the developer's machine; never given to a running service |
| People | The Supabase project owner; the n8n owner account (the editor is only on `localhost`, blocked at the tunnel); members of the Slack workspace; whoever has the Gmail account |
| The public | The web form and Slack's webhook only. Slack requests are signature-checked; there are rate limits; the evaluation webhook is not public ([setup](setup.md)) |

## Retention

| Data | Kept for | How it is enforced |
| --- | --- | --- |
| Enquiries, drafts, approvals, audit rows | Until deleted. Suggested for a client: 12 months for enquiries that didn't become work | `node scripts/clear-test-data.mjs --live --older-than 365 --keep-customers --apply` (for example monthly) |
| Customers and jobs | As long as the business needs them for its own records (invoices, warranties, gas safety work) | Kept by `--keep-customers`; removed for an erasure request (below) |
| n8n execution history | 14 days | n8n pruning (`docker-compose.yml`) |
| Calendar holds | 3 days unless confirmed | Housekeeping workflow, daily |
| Slack messages | Slack's retention settings for the workspace | Set a retention period on a paid plan, or delete by hand |
| Gmail | The mailbox's own rules | Delete by hand, or with Gmail filters |
| Evaluation test data | Not needed after a run | `node scripts/clear-test-data.mjs --apply` |

## Requests from individuals

**Access (subject access request):** search the `enquiries`, `customers` and `approvals` tables for the person's email address in the Supabase dashboard (or with SQL as the admin user), and search the Gmail mailbox and Slack for their name and address. The audit log entries for their enquiries hold the rest.

**Erasure:**

```bash
node scripts/clear-test-data.mjs --live --email person@example.com            # dry run: counts only
node scripts/clear-test-data.mjs --live --email person@example.com --apply    # delete
```

This removes their enquiries with the drafts, approvals and audit rows, any customer record with that address and its jobs, their tentative calendar holds and their Slack approval cards. Then delete their emails from Gmail (inbox and Sent), any Slack alerts or thread messages that mention them, and any confirmed calendar bookings. n8n's execution history ages out within 14 days; to remove it sooner, delete those executions in the n8n editor. Before erasing, check whether the business must keep any of it (for example a job record for a gas safety certificate).

## Secrets

- All keys and passwords live in `.env` on the host, which is git-ignored. The committed workflow files contain only placeholders; `n8n/deploy.mjs` fills in channel and calendar ids at deploy time, and only one secret, Slack's signing secret (n8n's Code sandbox can't read credentials), with a strict allowlist and format check.
- n8n stores its credentials encrypted. Database passwords are random and generated by `scripts/db-setup.mjs`, which can rotate them (then `node scripts/n8n-credentials.mjs --update "Supabase Postgres (n8n writes)"` and `docker compose up -d mcp-server`).
- The Google service account key lives outside the repository and is mounted into the MCP container read-only, as a Docker secret.
- Scripts never print secret values; before each commit, a scan checks that no `.env` value appears in the files being committed.
- Least-privilege Google scopes: Gmail `gmail.modify` and `gmail.labels` (no full-mailbox scope, so no permanent deletion), Calendar `calendar.events` and `calendar.readonly`.

## Known gaps before a real deployment

- **Hosting:** n8n runs on a PC through a free ngrok tunnel. For a client, move it to a managed host in the UK or EU, with backups and monitoring.
- **Database TLS** uses `no-verify` (encrypted, but the server certificate isn't checked against Supabase's CA). Pin the CA.
- **Agreements:** check each provider's data processing agreement and international transfer terms (Anthropic, Slack, ngrok and Google process data outside the UK), and list them in the business's privacy notice and records of processing.
- **Minimisation:** classification doesn't strictly need the sender's email and phone; they could be left out of that request. The audit log keeps tool results for debugging; a client might prefer to keep only the tool names after a few weeks.
- **Backups:** check what the Supabase plan backs up and for how long, and that deletions also age out of backups.
