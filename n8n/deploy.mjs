#!/usr/bin/env node
// Builds the workflows and creates/updates them in n8n by name through the public API,
// resolving credential and sub-workflow references to this instance's ids, then activates
// the ones with triggers. Prints names, ids and URLs only.
// Run: node n8n/deploy.mjs
import { readEnv } from "../scripts/lib/dotenv.mjs";
import { PATHS, WF, WORKFLOWS } from "./build.mjs";

const env = readEnv();
const N8N = process.env.N8N_URL ?? "http://localhost:5678";
if (!env.N8N_API_KEY) {
  console.error("N8N_API_KEY is empty in .env");
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${N8N}/api/v1${path}`, {
    method,
    headers: { "X-N8N-API-KEY": env.N8N_API_KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function listAll(path) {
  const items = [];
  let cursor;
  do {
    const page = await api("GET", `${path}?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    items.push(...(page.data ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const credentials = new Map((await listAll("/credentials")).map((c) => [c.name, c.id]));
const existing = new Map((await listAll("/workflows")).map((w) => [w.name, w]));
const deployedIds = new Map();

/**
 * Replace placeholders with this instance's values, only ever in memory (the files in n8n/workflows/
 * keep the placeholders):
 *   "__CREDENTIAL__<name>" / "__WORKFLOW__<name>"  -> ids looked up by name
 *   __ENV__<KEY>     -> a non-secret id from .env (Slack channel, calendar id)
 *   __SECRET__<KEY>  -> the one secret a Code node needs: Slack's signing secret, to verify requests
 *                       (n8n's Code sandbox can't read credentials)
 * Each key has a strict allowlist and format, so nothing else can be inlined by accident.
 */
const ENV_ALLOWED = {
  SLACK_ALERTS_CHANNEL_ID: /^[A-Z0-9]{8,14}$/,
  SLACK_APPROVAL_CHANNEL_ID: /^[A-Z0-9]{8,14}$/,
  GOOGLE_CALENDAR_ID: /^[a-z0-9._-]+@group\.calendar\.google\.com$/,
};
const SECRET_ALLOWED = { SLACK_SIGNING_SECRET: /^[0-9a-f]{32}$/ };
function resolve(wf) {
  let json = JSON.stringify(wf).replace(/"__(CREDENTIAL|WORKFLOW)__([^"]+)"/g, (_, kind, name) => {
    const id = kind === "CREDENTIAL" ? credentials.get(name) : deployedIds.get(name) ?? existing.get(name)?.id;
    if (!id) throw new Error(`${kind.toLowerCase()} "${name}" not found in n8n (run scripts/n8n-credentials.mjs / deploy order)`);
    return JSON.stringify(id);
  });
  json = json.replace(/__(ENV|SECRET)__([A-Z0-9_]+)/g, (_, kind, key) => {
    const format = (kind === "ENV" ? ENV_ALLOWED : SECRET_ALLOWED)[key];
    if (!format) throw new Error(`${key} may not be inlined into a workflow`);
    const value = env[key];
    if (!value || !format.test(value)) throw new Error(`${key} is missing or has an unexpected format in .env`);
    return value;
  });
  return JSON.parse(json);
}

for (const { workflow, activate } of WORKFLOWS) {
  const body = resolve(workflow);
  const current = existing.get(workflow.name);
  let id;
  if (current) {
    if (current.active) await api("POST", `/workflows/${current.id}/deactivate`);
    await api("PUT", `/workflows/${current.id}`, body);
    id = current.id;
  } else {
    id = (await api("POST", "/workflows", body)).id;
  }
  deployedIds.set(workflow.name, id);
  if (activate) await api("POST", `/workflows/${id}/activate`);
  console.log(`  ${current ? "updated" : "created"} ${workflow.name} (id ${id})${activate ? ", active" : ""}`);
}

console.log(`\n  Web form:      https://${env.NGROK_DOMAIN}/form/${PATHS.form}`);
console.log(`  Test webhook:  ${N8N}/webhook/${PATHS.testWebhook}  (header X-Harbourline-Test-Key)`);
console.log(`  Sub-workflow:  ${WF.classify}`);
