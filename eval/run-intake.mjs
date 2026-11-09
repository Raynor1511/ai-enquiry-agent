#!/usr/bin/env node
// Runs labelled test enquiries through the real pipeline (n8n "Test intake" webhook -> Classify
// sub-workflow -> Claude -> Supabase) and scores the classification against the labels.
// Each call costs real money (Claude Haiku 5.5: well under $0.01 per enquiry).
//   node eval/run-intake.mjs                      all 40 enquiries
//   node eval/run-intake.mjs --only enq_001,enq_015
//   node eval/run-intake.mjs --concurrency 2 --run-id my-run
// Writes eval/runs/<run-id>/results.json and summary.md (git-ignored).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnv } from "../scripts/lib/dotenv.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = readEnv();
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const N8N = process.env.N8N_URL ?? "http://localhost:5678";
const runId = arg("run-id", `intake-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const concurrency = Number(arg("concurrency", 4));
const only = arg("only", "")?.split(",").filter(Boolean);

const all = JSON.parse(readFileSync(path.join(here, "test-set", "enquiries.json"), "utf8"));
const enquiries = only?.length ? all.filter((e) => only.includes(e.id)) : all;
if (!enquiries.length) throw new Error("No enquiries selected");
if (!env.TEST_WEBHOOK_KEY) throw new Error("TEST_WEBHOOK_KEY is empty in .env");

async function send(e) {
  const started = Date.now();
  try {
    const { labels, ...enquiry } = e;
    const res = await fetch(`${N8N}/webhook/harbourline-test-intake`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Harbourline-Test-Key": env.TEST_WEBHOOK_KEY },
      body: JSON.stringify({ ...enquiry, run_id: runId }),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { id: e.id, http: res.status, wall_ms: Date.now() - started, result: body };
  } catch (err) {
    return { id: e.id, http: 0, wall_ms: Date.now() - started, result: { error: err.message } };
  }
}

// Simple worker pool.
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, enquiries.length) }, async () => {
    while (next < enquiries.length) {
      const e = enquiries[next++];
      const r = await send(e);
      results.push(r);
      const c = r.result;
      process.stdout.write(`  ${e.id}  ${r.http === 200 ? `${c.status ?? "?"} ${c.category ?? "-"}/${c.urgency ?? "-"}` : `HTTP ${r.http} ${c.error ?? ""}`}\n`);
    }
  }),
);

// ---------------------------------------------------------------------------------------------
// Scoring

const byId = new Map(results.map((r) => [r.id, r]));
const normPc = (p) => (p ?? "").toUpperCase().replace(/\s+/g, "");
const rows = enquiries.map((e) => {
  const r = byId.get(e.id);
  const c = r.result ?? {};
  const cls = c.classification ?? null;
  const L = e.labels;
  const expectedSvc = L.expected_service_ids ?? [];
  const gotSvc = cls?.service_ids ?? [];
  // The classifier only sees the message, so only score postcodes that actually appear in it
  // (some labels take the postcode from the customer record).
  const visibleText = normPc(`${e.subject ?? ""} ${e.body ?? ""} ${Object.values(e.form_fields ?? {}).join(" ")}`);
  const postcodeVisible = Boolean(L.postcode) && visibleText.includes(normPc(L.postcode).slice(0, 3));
  return {
    id: e.id,
    ok: r.http === 200 && Boolean(cls),
    status: c.status ?? null,
    error: c.error ?? (r.http !== 200 ? `HTTP ${r.http}` : null),
    expected: { category: L.category, urgency: L.urgency, injection: L.is_injection, services: expectedSvc, postcode: L.postcode },
    got: { category: c.category ?? null, urgency: c.urgency ?? null, injection: Boolean(cls?.injection_suspected), services: gotSvc, postcode: cls?.postcode ?? null },
    category_ok: c.category === L.category,
    urgency_ok: c.urgency === L.urgency,
    services_all_found: expectedSvc.every((s) => gotSvc.includes(s)),
    // Full postcode, or the district when that's all the message gave.
    postcode_ok: postcodeVisible
      ? [normPc(L.postcode), normPc(L.postcode).slice(0, -3)].includes(normPc(cls?.postcode)) || normPc(cls?.postcode) === normPc(L.postcode)
      : null,
    overrides: c.overrides ?? [],
    summary: cls?.summary ?? null,
    cost_usd: c.cost_usd ?? null,
    duration_ms: c.duration_ms ?? null,
    wall_ms: r.wall_ms,
    attempts: c.attempts ?? null,
  };
});

const n = rows.length;
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const count = (f) => rows.filter(f).length;
const emergencies = rows.filter((r) => r.expected.category === "emergency");
const caughtEmergencies = emergencies.filter((r) => r.got.urgency === "emergency");
const falseAlarms = rows.filter((r) => r.expected.category !== "emergency" && r.got.urgency === "emergency");
const injections = rows.filter((r) => r.expected.injection);
const flaggedInjections = injections.filter((r) => r.got.injection);
const falseInjection = rows.filter((r) => !r.expected.injection && r.got.injection);
const withServices = rows.filter((r) => r.expected.services.length);
const withPostcode = rows.filter((r) => r.postcode_ok !== null);
const costs = rows.map((r) => r.cost_usd).filter((x) => typeof x === "number");
const durations = rows.map((r) => r.duration_ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const p90 = (xs) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : 0);

const categories = ["new_job_request", "quote_request", "emergency", "complaint", "existing_customer_followup", "spam"];
const short = { new_job_request: "new_job", quote_request: "quote", emergency: "emerg", complaint: "complaint", existing_customer_followup: "followup", spam: "spam" };
const matrix = [
  `| expected \\ got | ${categories.map((c) => short[c]).join(" | ")} | other |`,
  `|---|${categories.map(() => "---").join("|")}|---|`,
  ...categories.map((exp) => {
    const cells = categories.map((got) => count((r) => r.expected.category === exp && r.got.category === got));
    const other = count((r) => r.expected.category === exp && !categories.includes(r.got.category));
    return `| **${short[exp]}** | ${cells.join(" | ")} | ${other} |`;
  }),
];

const misses = rows.filter((r) => !r.category_ok || !r.urgency_ok || r.expected.injection !== r.got.injection || !r.ok);
const summary = [
  `# Intake evaluation: ${runId}`,
  "",
  `${n} enquiries · model ${results[0]?.result?.model ?? "?"} · ${new Date().toISOString()}`,
  "",
  "| Measure | Result | Target |",
  "|---|---|---|",
  `| Pipeline completed | ${count((r) => r.ok)}/${n} (${pct(count((r) => r.ok), n)}) | 100% |`,
  `| Category accuracy | ${count((r) => r.category_ok)}/${n} (${pct(count((r) => r.category_ok), n)}) | ≥ 90% |`,
  `| Urgency accuracy | ${count((r) => r.urgency_ok)}/${n} (${pct(count((r) => r.urgency_ok), n)}) | n/a |`,
  `| **Emergencies caught** | ${caughtEmergencies.length}/${emergencies.length} | **all** |`,
  `| False emergency alarms | ${falseAlarms.length} | low |`,
  `| **Injections flagged** | ${flaggedInjections.length}/${injections.length} | **all** |`,
  `| Injection false positives | ${falseInjection.length} | low |`,
  `| Expected services found | ${count((r) => r.expected.services.length && r.services_all_found)}/${withServices.length} | n/a |`,
  `| Postcode extracted | ${count((r) => r.postcode_ok === true)}/${withPostcode.length} | n/a |`,
  `| Safety-rule overrides | ${count((r) => r.overrides.length)} | n/a |`,
  `| Cost per enquiry | avg $${avg(costs).toFixed(5)} · total $${costs.reduce((a, b) => a + b, 0).toFixed(4)} | n/a |`,
  `| Time per enquiry (pipeline) | avg ${(avg(durations) / 1000).toFixed(1)} s · p90 ${(p90(durations) / 1000).toFixed(1)} s | n/a |`,
  "",
  "## Category confusion matrix",
  "",
  ...matrix,
  "",
  "## Misses",
  "",
  misses.length ? "| id | expected | got | injection exp/got | note |\n|---|---|---|---|---|" : "None.",
  ...misses.map((r) => `| ${r.id} | ${r.expected.category}/${r.expected.urgency} | ${r.got.category ?? "-"}/${r.got.urgency ?? "-"} | ${r.expected.injection}/${r.got.injection} | ${(r.error ?? r.summary ?? "").replace(/\|/g, "/").slice(0, 90)} |`),
  "",
].join("\n");

const outDir = path.join(here, "runs", runId);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ run_id: runId, rows, raw: results }, null, 2));
writeFileSync(path.join(outDir, "summary.md"), summary);
console.log("\n" + summary);
console.log(`Saved eval/runs/${runId}/`);
