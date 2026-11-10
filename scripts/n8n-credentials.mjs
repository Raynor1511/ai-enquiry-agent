#!/usr/bin/env node
// Creates the n8n credentials this project needs, from .env, through n8n's public API.
// Skips any credential whose name already exists. Prints names and ids only, never secrets.
// Google credentials still need a one-time "Sign in with Google" click in the n8n editor.
// Run: node scripts/n8n-credentials.mjs
//      node scripts/n8n-credentials.mjs --update "Supabase Postgres (n8n writes)"
//        replaces an existing credential's data from .env (e.g. after db-setup rotated a password)
//        and asks n8n to test it. Not allowed for the Google credentials: it would drop their sign-in.
import { readEnv } from "./lib/dotenv.mjs";

const env = readEnv();
const N8N = process.env.N8N_URL ?? "http://localhost:5678";
if (!env.N8N_API_KEY) {
  console.error("N8N_API_KEY is empty in .env");
  process.exit(1);
}
const updates = process.argv.flatMap((a, i, all) => (a === "--update" && all[i + 1] ? [all[i + 1]] : []));

const api = async (method, path, body) => {
  const res = await fetch(`${N8N}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": env.N8N_API_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

// n8n writes as the least-privilege n8n_writer role (seed/sql/003_roles.sql), never as the admin user.
const db = env.N8N_DB_URL ? new URL(env.N8N_DB_URL.replace(/^postgresql:/, "postgres:")) : null;
// Like the pg driver: decode %XX escapes, but keep a password with a bare "%" as written.
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Least-privilege scopes: no full-mailbox scope (which allows permanent deletion).
const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.labels"];
const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"];

const wanted = [
  {
    name: "Harbourline Gmail",
    type: "gmailOAuth2",
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    data: () => ({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      customScopes: true,
      enabledScopes: GMAIL_SCOPES.join(" "),
    }),
  },
  {
    name: "Harbourline Calendar",
    type: "googleCalendarOAuth2Api",
    needs: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    data: () => ({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      customScopes: true,
      enabledScopes: CALENDAR_SCOPES.join(" "),
    }),
  },
  {
    name: "Anthropic",
    type: "anthropicApi",
    needs: ["ANTHROPIC_API_KEY"],
    data: () => ({ apiKey: env.ANTHROPIC_API_KEY }),
  },
  {
    name: "Supabase Postgres (n8n writes)",
    type: "postgres",
    needs: ["N8N_DB_URL"], // written by scripts/db-setup.mjs
    data: () => ({
      host: db.hostname,
      port: Number(db.port || 5432),
      database: decode(db.pathname.slice(1) || "postgres"),
      user: decode(db.username),
      password: decode(db.password),
      ssl: "require",
      // Supabase signs its server certificate with its own CA (see docs/setup.md).
      allowUnauthorizedCerts: true,
      maxConnections: 5,
    }),
  },
  {
    name: "Harbourline Slack",
    type: "slackApi",
    needs: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
    // The signing secret lets n8n verify that requests really come from Slack.
    data: () => ({ accessToken: env.SLACK_BOT_TOKEN, signatureSecret: env.SLACK_SIGNING_SECRET }),
  },
  {
    name: "Harbourline test webhook",
    type: "httpHeaderAuth",
    needs: ["TEST_WEBHOOK_KEY"],
    // Protects the evaluation webhook (n8n/build.mjs -> Test intake).
    data: () => ({ name: "X-Harbourline-Test-Key", value: env.TEST_WEBHOOK_KEY }),
  },
  {
    name: "Harbourline demo service",
    type: "httpHeaderAuth",
    needs: ["DEMO_N8N_KEY"],
    // Protects the demo page's webhooks (n8n/build.mjs -> Demo); only the demo service sends it.
    data: () => ({ name: "X-Harbourline-Demo-Key", value: env.DEMO_N8N_KEY }),
  },
  {
    name: "Harbourline MCP server",
    type: "httpBearerAuth",
    needs: ["MCP_AUTH_TOKEN"],
    data: () => ({ token: env.MCP_AUTH_TOKEN }),
  },
];

const existing = new Map();
let cursor;
do {
  const page = await api("GET", `/credentials?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
  for (const c of page.data ?? []) existing.set(c.name, c);
  cursor = page.nextCursor;
} while (cursor);

const OAUTH = new Set(["gmailOAuth2", "googleCalendarOAuth2Api"]);
for (const name of updates) {
  const cred = wanted.find((c) => c.name === name);
  if (!cred) throw new Error(`--update: no credential called "${name}" in this script`);
  if (OAUTH.has(cred.type)) throw new Error(`--update: "${name}" is a Google sign-in; reconnect it in the n8n editor instead`);
  if (!existing.has(name)) throw new Error(`--update: "${name}" doesn't exist in n8n yet; run without --update to create it`);
}

/** Ask n8n to connect with a stored credential (prints n8n's verdict, never the data). */
async function testCredential(id, name) {
  try {
    const r = await api("POST", `/credentials/${id}/test`);
    console.log(`    test: ${r.status}${r.message ? ` (${r.message})` : ""}`);
    if (r.status !== "OK") process.exitCode = 1;
  } catch (err) {
    console.log(`    test of ${name} could not run: ${err.message.slice(0, 200)}`);
    process.exitCode = 1;
  }
}

for (const cred of wanted) {
  const missing = cred.needs.filter((k) => !env[k]);
  if (existing.has(cred.name)) {
    const id = existing.get(cred.name).id;
    if (!updates.includes(cred.name)) {
      console.log(`  = ${cred.name} [${cred.type}] already exists (id ${id})`);
      continue;
    }
    if (missing.length) throw new Error(`--update ${cred.name}: missing ${missing.join(", ")} in .env`);
    await api("PATCH", `/credentials/${id}`, { data: cred.data() });
    console.log(`  ~ ${cred.name} [${cred.type}] updated from .env (id ${id})`);
    await testCredential(id, cred.name);
    continue;
  }
  if (missing.length) {
    console.log(`  - ${cred.name}: skipped, missing ${missing.join(", ")} in .env`);
    continue;
  }
  const created = await api("POST", "/credentials", { name: cred.name, type: cred.type, data: cred.data() });
  console.log(`  + ${cred.name} [${cred.type}] created (id ${created.id})`);
}
