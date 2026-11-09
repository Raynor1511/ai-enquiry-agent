# Setup

How to run the whole stack on one machine: n8n, the MCP server and an ngrok tunnel in Docker, with Supabase as the database.

## Prerequisites

- Docker Desktop
- Node 20+ (22 LTS recommended), for the setup scripts and tests
- Accounts: Anthropic Console, Supabase, ngrok (free), Google and Slack (for later phases)

## 1. Configure `.env`

```bash
node scripts/init-env.mjs
```

This creates `.env` from `.env.example`, or adds any missing keys to an existing one. It generates `MCP_AUTH_TOKEN` and `N8N_ENCRYPTION_KEY`, prints key names only, and is safe to re-run. Back up `N8N_ENCRYPTION_KEY`: n8n needs it to decrypt the credentials it stores.

Fill in:

| Key | Where to find it |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic Console → API Keys |
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → **Secret keys** (`sb_secret_…`), not the publishable key |
| `SUPABASE_DB_URL` | Supabase → **Connect** → Connection String → **Session pooler**, with your password filled in |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | ngrok dashboard: your authtoken, and your free dev domain without `https://` |

Use the **Session pooler**, not "Direct connection". Supabase's direct host is IPv6-only, which most home networks and Docker Desktop can't reach.

If a value contains `$`, run `node scripts/quote-env.mjs`. Docker Compose would otherwise treat `$...` as a variable.

## 2. Set up the database

```bash
node scripts/db-setup.mjs
```

The script:

1. Applies `seed/sql/001_schema.sql`, `002_seed.sql` and `003_roles.sql`. All three are idempotent.
2. Gives the `mcp_readonly` role a fresh random password.
3. Writes the read-only connection to `DATABASE_URL`.
4. Connects as that role to prove it can read but not write.

Then set `DATA_SOURCE=postgres` in `.env`, and check that the MCP server returns the same answers from the database as from the JSON files:

```bash
cd mcp-server && npm run test:pg
```

Supabase signs its server certificates with its own CA, so the connection uses `sslmode=no-verify`: encrypted, but without certificate pinning. For a client deployment, download Supabase's CA certificate and verify against it.

## 3. Start the stack

```bash
docker compose up -d --build
```

| Service | Address | Notes |
| --- | --- | --- |
| n8n editor | http://localhost:5678 | This machine only. Create the owner account on first visit |
| MCP server | `http://mcp-server:3333/mcp` from n8n; http://localhost:3333 from this machine | Bearer `MCP_AUTH_TOKEN` |
| Public webhooks | `https://<NGROK_DOMAIN>/webhook/...` | For Slack and the web form |

The ngrok traffic policy (`infra/ngrok-policy.yml`) passes only `/webhook*` and `/form*` paths to n8n. Everything else, including the editor, login and REST API, gets an empty 404 from ngrok. People opening the address in a browser see ngrok's free-plan warning page once; Slack and other server-to-server calls don't.

Stop with `docker compose down`. n8n's data lives in the `harbourline_n8n_data` volume and survives restarts; `down -v` deletes it.
