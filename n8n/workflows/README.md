# n8n workflows

Exported n8n workflows (JSON) go here, with **credentials stripped**. n8n exports reference credentials by name and id only, but check every export for pasted keys, tokens or webhook secrets before committing.

Planned workflows:

| Workflow | Phase |
| --- | --- |
| `intake.json`: web form webhook and Gmail trigger → normalise → dedupe → classify → save | 1 |
| `draft.json`: AI Agent with the MCP tools → draft, reasoning, confidence, price grounding check | 3 |
| `approval.json`: Slack card → Approve / Edit / Reject → send, update records, calendar hold | 4 |
| `error-handler.json`: posts failures to Slack | 5 |
