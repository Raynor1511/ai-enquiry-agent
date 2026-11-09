# n8n workflows

These JSON files are **generated** by `n8n/build.mjs` from the source in `n8n/src/`. Don't edit them by hand.

- **Credentials:** referenced by name only, with placeholder ids. `n8n/deploy.mjs` resolves them per instance, so no credential ids or secrets are ever committed.
- **Importing by hand:** the files import into any n8n 2.x instance. Create credentials with the same names, then fix the references in the editor.

| Workflow | File | What it does |
| --- | --- | --- |
| Harbourline · Classify enquiry | `classify.json` | Sub-workflow. Inserts the enquiry (skipping duplicate message ids), classifies it with Claude Haiku 5.5 using structured output, retries invalid output once, applies safety rules, then saves the classification and an audit log entry |
| Harbourline · Intake (form + Gmail) | `intake.json` | The public web form and the Gmail inbox (checked every minute). Each source is normalised and then classified; handled emails are marked as read |
| Harbourline · Test intake (eval) | `test-intake.json` | Header-protected webhook that `eval/run-intake.mjs` uses. It returns the classification in the response |

```bash
node --test n8n/test/      # unit tests for the pipeline logic inlined into Code nodes
node n8n/build.mjs         # regenerate these files
node n8n/deploy.mjs        # build + create/update + activate in n8n (needs N8N_API_KEY)
```

Planned next: drafting (Phase 3), Slack approval (Phase 4), error handler (Phase 5).
