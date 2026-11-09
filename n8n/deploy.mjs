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

/** Replace __CREDENTIAL__<name> and __WORKFLOW__<name> placeholders with real ids. */
function resolve(wf) {
  const json = JSON.stringify(wf).replace(/"__(CREDENTIAL|WORKFLOW)__([^"]+)"/g, (_, kind, name) => {
    const id = kind === "CREDENTIAL" ? credentials.get(name) : deployedIds.get(name) ?? existing.get(name)?.id;
    if (!id) throw new Error(`${kind.toLowerCase()} "${name}" not found in n8n (run scripts/n8n-credentials.mjs / deploy order)`);
    return JSON.stringify(id);
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
