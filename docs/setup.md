# Setup

How to run the whole stack on one machine: n8n, the MCP server and an ngrok tunnel in Docker, with Supabase as the database.

## Prerequisites

- Docker Desktop
- Node 20+ (22 LTS recommended), for the setup scripts and tests
- Accounts: Anthropic Console, Supabase, ngrok (free), a demo Google account, Slack

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

## 3. Connect Google

In the Google Cloud console, signed in with the demo Google account:

1. **Project and APIs:** create a project, then enable the **Gmail API** and the **Google Calendar API** (APIs & Services → Library).
2. **Consent screen:** Google Auth platform → Branding → Get Started.
   - Set an app name and support email, choose **External**, and set a contact email.
   - Under App domain, add the homepage and privacy policy URLs (this project uses a small public GitHub Pages site), and add their domain under Authorized domains. Don't upload a logo: a logo triggers Google's formal app review.
   - Then go to Audience → **Publish app**. Apps left in "Testing" have their logins expire every 7 days.
3. **OAuth client:** Google Auth platform → Clients → Create Client.
   - Choose **Web application**, with the redirect URI `http://localhost:5678/rest/oauth2-credential/callback`.
   - Copy the Client ID and secret into `.env` straight away: Google only shows the secret once.
4. **Service account:** IAM & Admin → Service Accounts → Create, with no roles. Then Keys → Add key → JSON.
   - Store the key file **outside the repo** and set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to its path.
5. **Demo calendar:** in Google Calendar, create the demo calendar, set to London time.
   - Share it with the service account's email, with **Make changes to events**. This lets the seed script add bookings.
   - Put its Calendar ID in `GOOGLE_CALENDAR_ID`, and set `CALENDAR_SOURCE=google`.
6. **n8n API key:** n8n → Settings → n8n API → Create an API key, then put it in `N8N_API_KEY`.

Then:

```bash
node scripts/n8n-credentials.mjs                    # Gmail, Calendar, Anthropic, Postgres, MCP credentials
cd mcp-server && npm run build
node scripts/google-calendar.mjs seed               # two weeks of demo bookings, relative to today
node scripts/google-calendar.mjs check              # read-only token: can read, cannot write
```

In n8n, open **Harbourline Gmail** and **Harbourline Calendar** and click **Sign in with Google** on each. Because the app is unverified, Google shows a warning: choose Advanced → Go to (app name).

The credentials use narrow scopes:

| Credential | Scopes |
| --- | --- |
| Gmail in n8n | `gmail.modify` and `gmail.labels`: read, send and label, but not permanently delete |
| Calendar in n8n | `calendar.events` and `calendar.readonly` |
| MCP server | `calendar.readonly` only. It reads free/busy times, never event details, and Google refuses its write attempts |

Re-run `google-calendar.mjs seed` whenever the demo calendar should show a fresh two weeks. It only replaces events it created.

## 4. Connect Slack

1. Create public channels `#enquiries` (approval cards) and `#alerts` (emergencies and errors) in the demo workspace.
2. Run `node scripts/slack-manifest.mjs` to print the app manifest with your ngrok domain filled in. Paste it at api.slack.com/apps → **Create New App** → **From a manifest**, using the YAML tab, then **Install to Workspace**.
   - The bot scopes are `chat:write`, `channels:read` and `users:read`.
   - Interactivity (button clicks and the Edit pop-up) goes to `https://<NGROK_DOMAIN>/webhook/slack-interactions`.
3. Put the **Bot User OAuth Token** and the **Signing Secret** in `.env`, along with the two channel names.
4. Invite the bot to both channels: `/invite @Harbourline Enquiries`.
5. Run `node scripts/slack-setup.mjs --test-message`. It checks the token, confirms the bot is in both channels, saves their IDs to `.env`, and posts a test message.
6. Run `node scripts/n8n-credentials.mjs` again to add the Slack credential to n8n.

## 5. Start the stack

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
