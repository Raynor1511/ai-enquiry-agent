#!/usr/bin/env node
// Creates the n8n credentials this project needs, from .env, through n8n's public API.
// Skips any credential whose name already exists. Prints names and ids only, never secrets.
// Google credentials still need a one-time "Sign in with Google" click in the n8n editor.
// Run: node scripts/n8n-credentials.mjs
import { readEnv } from "./lib/dotenv.mjs";

const env = readEnv();
const N8N = process.env.N8N_URL ?? "http://localhost:5678";
if (!env.N8N_API_KEY) {
  console.error("N8N_API_KEY is empty in .env");
  process.exit(1);
}

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

const db = new URL(env.SUPABASE_DB_URL.replace(/^postgresql:/, "postgres:"));
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
    needs: ["SUPABASE_DB_URL"],
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

for (const cred of wanted) {
  if (existing.has(cred.name)) {
    console.log(`  = ${cred.name} [${cred.type}] already exists (id ${existing.get(cred.name).id})`);
    continue;
  }
  const missing = cred.needs.filter((k) => !env[k]);
  if (missing.length) {
    console.log(`  - ${cred.name}: skipped, missing ${missing.join(", ")} in .env`);
    continue;
  }
  const created = await api("POST", "/credentials", { name: cred.name, type: cred.type, data: cred.data() });
  console.log(`  + ${cred.name} [${cred.type}] created (id ${created.id})`);
}
