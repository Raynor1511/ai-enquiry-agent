# n8n workflows

These JSON files are **generated** by `n8n/build.mjs` from the source in `n8n/src/`; don't edit them by hand. Credentials are referenced by name with placeholder ids, and instance values (Slack channel ids, calendar id, the Slack signing secret) are `__ENV__` / `__SECRET__` placeholders; `n8n/deploy.mjs` fills them in memory when deploying, so no ids or secrets are ever committed.

| Workflow | File | What it does |
| --- | --- | --- |
| Harbourline · Intake (form + Gmail) | `intake.json` | Public web form and the Gmail inbox (every minute, excluding the mailbox's own messages) → normalise → Classify → Draft → Post for approval; handled emails are marked read |
| Harbourline · Classify enquiry | `classify.json` | Sub-workflow: insert (skipping duplicate message ids), classify with Claude Haiku 5.5 (structured output), retry once, safety rules, save + audit |
| Harbourline · Draft reply | `draft.json` | Sub-workflow: emergency alert to #alerts, Claude Sonnet 5.5 tool loop over the MCP server (up to 6 visible turns), price and contact checks, save + audit |
| Harbourline · Post for approval | `approval.json` | Sub-workflow: approval card in #enquiries (or "manual reply needed"), status `awaiting_approval` |
| Harbourline · Slack interactions | `interactions.json` | Public webhook for Slack buttons and modals: signature check, Approve / Edit / Reject, Gmail reply or send, approval / customer / job records, tentative calendar holds, card outcome; **Process** on a Spam-folder alert runs that email through the pipeline |
| Harbourline · Test intake (eval) | `test-intake.json` | Header-protected webhook for `eval/run-intake.mjs`: Classify + Draft, result in the response; never posts to Slack or sends email |
| Harbourline · Housekeeping | `housekeeping.json` | Scheduled: daily release of tentative holds nobody confirmed (3 days), Spam-folder check twice a day (real-looking enquiries listed in #alerts with a Process button), hourly reminders in business hours for approval cards still waiting |
| Harbourline · Alerts | `alerts.json` | Error workflow of all the others (Error Trigger) and sub-workflow for handled failures: posts to #alerts, mutes repeats, drops caller duplicates |

```bash
node --test n8n/test/      # unit tests for the logic inlined into Code nodes, plus build checks
node n8n/build.mjs         # regenerate these files
node n8n/deploy.mjs        # build + create/update + activate in n8n (needs N8N_API_KEY)
```

To import by hand into another n8n 2.x instance: create credentials with the same names, import the files, then replace the placeholders (channel ids, calendar id, signing secret) in the nodes that use them.
