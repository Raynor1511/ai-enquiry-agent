#!/usr/bin/env node
// Grades the drafts of an evaluation run against their labelled required and forbidden facts:
// a Claude judge rules on every fact (quoting the reply as evidence) and a script checks the
// figures; disagreements and failures go into a spot-check sheet for a person.
//
//   node eval/grade.mjs --run <run-id>               grade eval/runs/<run-id>/results.json
//   node eval/grade.mjs --run <run-id> --only enq_001,enq_006
//   node eval/grade.mjs --selftest                   check the judge on known-good / known-bad replies
// Options: --judge <model> (default claude-opus-5-5) · --effort <low|medium|high> (default medium)
//          --concurrency <n> (default 4) · --fresh (ignore earlier grades for this run)
// Writes, next to the run: grades.jsonl (one row per graded draft, written as each finishes, so a
// re-run resumes), errors.jsonl (judge calls that failed: never counted as a grade), grading.md
// (the summary) and spot-check.md (judgments for a person to check).
// Costs money: each draft is one judge call (~$0.02-0.04 with Claude Opus 5.5 at medium effort).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { readEnv } from "../scripts/lib/dotenv.mjs";
import { JUDGE_SCHEMA, JUDGE_SYSTEM, checkVerdicts, costOf, judgeMessage, scoreDraft, spotCheckSample, wilson } from "./lib/grading.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const JUDGE = arg("judge", "claude-opus-5-5");
const EFFORT = arg("effort", "medium");
const CONCURRENCY = Number(arg("concurrency", 4));
const CASE_CEILING_MS = 5 * 60_000; // hard wall-clock limit per draft, whatever the stream does
const SETS = { main: "test-set/enquiries.json", "held-out": "test-set/held-out.json" };

const env = readEnv();
if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is empty in .env");
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 4, timeout: 180_000 });
const loadSet = (name) => {
  if (!SETS[name]) throw new Error(`unknown test set ${name}`);
  return new Map(JSON.parse(readFileSync(path.join(here, SETS[name]), "utf8")).map((e) => [e.id, e]));
};

const withCeiling = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`no result within ${ms / 1000} s`), { failure: "timeout" })), ms))]);

/** One judge verdict for one draft: up to two attempts when the output is unusable. */
async function judge(enquiry, draft, labels) {
  const attempts = [];
  let error = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    let res;
    try {
      res = await withCeiling(
        client.beta.messages.create({
          model: JUDGE,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: JUDGE_SYSTEM,
          output_config: { effort: EFFORT, format: { type: "json_schema", schema: JUDGE_SCHEMA } },
          messages: [{ role: "user", content: judgeMessage(enquiry, draft, labels) }],
        }),
        CASE_CEILING_MS,
      );
    } catch (err) {
      const failure = err.failure ?? (err instanceof Anthropic.RateLimitError ? "rate_limited" : err instanceof Anthropic.APIError ? `api_${err.status ?? "error"}` : "harness");
      attempts.push({ attempt, failure, message: String(err.message).slice(0, 300), ms: Date.now() - started });
      error = failure;
      if (failure.startsWith("api_4") && failure !== "api_429") break; // a bad request won't fix itself
      continue;
    }
    const fallback = (res.usage?.iterations ?? []).some((x) => x.type === "fallback_message");
    const a = { attempt, model: res.model, fallback, usage: res.usage, stop_reason: res.stop_reason, ms: Date.now() - started };
    attempts.push(a);
    if (res.model !== JUDGE && !fallback) { error = "served_model_mismatch"; break; }
    if (res.stop_reason === "refusal") { error = "refusal"; break; }
    if (res.stop_reason === "max_tokens") { error = "truncated"; continue; }
    let parsed = null;
    try {
      parsed = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
    } catch {
      error = "unparseable";
      continue;
    }
    const verdicts = checkVerdicts(parsed, labels);
    if (!verdicts.ok) { error = "incomplete_verdicts"; a.detail = verdicts.error; continue; }
    return { ok: true, verdicts, attempts };
  }
  return { ok: false, error, attempts };
}

const judgeCost = (attempts) => attempts.reduce((sum, a) => sum + (costOf(a.model ?? JUDGE, a.usage) ?? 0), 0);

async function pool(items, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

// ---------------------------------------------------------------------------------------------
// --selftest: the judge must pass the oracles and fail every known-bad reply

if (flag("selftest")) {
  const fixtures = JSON.parse(readFileSync(path.join(here, "grader-fixtures.json"), "utf8")).cases;
  const set = loadSet("main");
  const jobs = fixtures.flatMap((f, i) => {
    const other = fixtures[(i + 1) % fixtures.length];
    return [
      { id: f.id, variant: "oracle", draft: f.oracle, expect: "pass" },
      { id: f.id, variant: "oracle + forbidden statement", draft: { ...f.oracle, body: `${f.oracle.body}\n\n${f.violation}` }, expect: "violation" },
      { id: f.id, variant: "empty reply", draft: { subject: "", body: "" }, expect: "fail" },
      { id: f.id, variant: "\"I don't know.\"", draft: { subject: "Re: your enquiry", body: "I don't know." }, expect: "fail" },
      { id: f.id, variant: `reply to the wrong enquiry (${other.id})`, draft: other.oracle, expect: "fail" },
    ];
  });
  const out = [];
  let spent = 0;
  await pool(jobs, async (j) => {
    const e = set.get(j.id);
    const r = await judge(e, j.draft, e.labels);
    spent += judgeCost(r.attempts);
    if (!r.ok) return out.push({ ...j, got: `grader error: ${r.error}`, ok: false });
    const s = scoreDraft(e.labels, r.verdicts, `${j.draft.subject}\n${j.draft.body}`);
    const got = s.pass ? "pass" : !s.clean ? "violation" : "fail";
    const ok = j.expect === "fail" ? !s.pass && s.required_met === 0 : got === j.expect;
    out.push({ ...j, got: `${got} (required ${s.required_met}/${s.required_total}, forbidden violated ${s.forbidden_violated}/${s.forbidden_total})`, ok, score: s });
  });
  const pos = (o) => jobs.findIndex((j) => j.id === o.id && j.variant === o.variant);
  out.sort((a, b) => pos(a) - pos(b));
  console.log(`Judge self-test · ${JUDGE} · effort ${EFFORT}\n`);
  for (const o of out) console.log(`  ${o.ok ? "✓" : "✗"} ${o.id} · ${o.variant}: expected ${o.expect}, got ${o.got}`);
  const bad = out.filter((o) => !o.ok);
  for (const o of bad.filter((x) => x.score)) {
    for (const v of [...o.score.required, ...o.score.forbidden].filter((x) => (o.expect === "pass") === (x.verdict === "not_met" || x.verdict === "violated"))) {
      console.log(`      ${o.id} #${v.item} ${v.verdict}: ${v.reason} [${v.evidence}]`);
    }
  }
  console.log(`\n${out.length - bad.length}/${out.length} as expected · judge cost $${spent.toFixed(3)}`);
  process.exit(bad.length ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Grade a run

const runId = arg("run");
if (!runId) throw new Error("Use --run <run-id> (a directory in eval/runs/) or --selftest");
const runDir = path.join(here, "runs", runId);
const run = JSON.parse(readFileSync(path.join(runDir, "results.json"), "utf8"));
const setName = run.set ?? "main";
const set = loadSet(setName);
const only = arg("only", "")?.split(",").filter(Boolean);
const gradesFile = path.join(runDir, "grades.jsonl");
const errorsFile = path.join(runDir, "errors.jsonl");
if (flag("fresh")) for (const f of [gradesFile, errorsFile]) if (existsSync(f)) writeFileSync(f, "");

// Rows already graded by this judge at this effort are kept (resume after a crash or a partial run).
const previous = existsSync(gradesFile)
  ? readFileSync(gradesFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.judge_model === JUDGE && g.effort === EFFORT)
  : [];
const done = new Set(previous.map((g) => g.id));

const toGrade = run.rows.filter((r) => set.get(r.id)?.labels.should_reply && (!only?.length || only.includes(r.id)));
const pending = toGrade.filter((r) => !done.has(r.id));
console.log(`Grading ${runId} (${setName} set): ${toGrade.length} enquiries that need a reply, ${pending.length} to grade, judge ${JUDGE} at ${EFFORT} effort`);

const fresh = [];
await pool(pending, async (row) => {
  const e = set.get(row.id);
  const base = { id: row.id, category: e.labels.category, is_injection: e.labels.is_injection, judge_model: JUDGE, effort: EFFORT, pipeline_checks: row.draft ? { prices_ok: row.draft.prices_ok, unsupported: row.draft.unsupported, contacts_ok: row.draft.contacts_ok, needs_review: row.draft.needs_review } : null };
  if (!row.draft?.drafted || !row.draft.body) {
    // No draft where one was needed is a failed case, not a grader error.
    const g = { ...base, status: "no_draft", pass: false, all_required: false, clean: true, required_met: 0, required_total: e.labels.required_facts.length, forbidden_violated: 0, forbidden_total: e.labels.forbidden_facts.length, disagreements: 0, required: [], forbidden: [], judge_cost_usd: 0 };
    appendFileSync(gradesFile, JSON.stringify(g) + "\n");
    fresh.push(g);
    return console.log(`  ${row.id}  no draft (${row.draft?.status ?? "none"})`);
  }
  const r = await judge(e, { subject: row.draft.subject, body: row.draft.body }, e.labels);
  const cost = judgeCost(r.attempts);
  if (!r.ok) {
    appendFileSync(errorsFile, JSON.stringify({ id: row.id, judge_model: JUDGE, effort: EFFORT, failure: r.error, attempts: r.attempts, judge_cost_usd: cost }) + "\n");
    return console.log(`  ${row.id}  GRADER ERROR ${r.error}`);
  }
  const s = scoreDraft(e.labels, r.verdicts, `${row.draft.subject}\n${row.draft.body}`);
  const last = r.attempts.at(-1);
  const g = { ...base, status: "graded", ...s, judge_served_model: last.model, judge_fallback: last.fallback, judge_attempts: r.attempts.length, judge_usage: last.usage, judge_cost_usd: cost, judge_ms: last.ms };
  appendFileSync(gradesFile, JSON.stringify(g) + "\n");
  fresh.push(g);
  console.log(`  ${row.id}  ${s.pass ? "pass" : "FAIL"}  required ${s.required_met}/${s.required_total} · forbidden violated ${s.forbidden_violated}/${s.forbidden_total}${s.disagreements ? ` · ${s.disagreements} disagreement(s)` : ""}`);
});

// ---------------------------------------------------------------------------------------------
// Summary and spot-check sheet (from every row for this judge and effort, old and new)

const order = new Map(toGrade.map((r, i) => [r.id, i]));
const grades = [...previous, ...fresh].filter((g) => order.has(g.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
const errors = existsSync(errorsFile) ? readFileSync(errorsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.judge_model === JUDGE && x.effort === EFFORT && !grades.some((g) => g.id === x.id)) : [];
const n = grades.length;
const count = (f) => grades.filter(f).length;
const pct = (k, m) => (m ? `${((100 * k) / m).toFixed(1)}%` : "n/a");
const ci = (k, m) => {
  const w = wilson(k, m);
  return m ? `${(100 * w.low).toFixed(0)}–${(100 * w.high).toFixed(0)}%` : "n/a";
};
const reqTotal = grades.reduce((a, g) => a + g.required_total, 0);
const reqMet = grades.reduce((a, g) => a + g.required_met, 0);
const forbTotal = grades.reduce((a, g) => a + g.forbidden_total, 0);
const forbViol = grades.reduce((a, g) => a + g.forbidden_violated, 0);
const passes = count((g) => g.pass);
const injections = grades.filter((g) => g.is_injection);
const judgeSpend = [...grades, ...errors].reduce((a, g) => a + (g.judge_cost_usd ?? 0), 0);
const graded = grades.filter((g) => g.status === "graded");
const short = (s, k = 110) => String(s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, k);

const failingLines = grades.filter((g) => !g.pass).flatMap((g) => [
  `### ${g.id} · ${g.category}${g.is_injection ? " · injection" : ""}`,
  "",
  ...(g.status === "no_draft" ? ["No draft was produced, so every required fact counts as missing.", ""] : []),
  ...g.required.filter((v) => v.verdict === "not_met").map((v) => `- **Missing:** ${v.fact}  \n  _Judge:_ ${short(v.reason, 300)}${v.evidence ? ` _Quote:_ "${short(v.evidence, 200)}"` : ""}`),
  ...g.forbidden.filter((v) => v.verdict === "violated").map((v) => `- **Forbidden, but present:** ${v.fact}  \n  _Judge:_ ${short(v.reason, 300)}${v.evidence ? ` _Quote:_ "${short(v.evidence, 200)}"` : ""}`),
  "",
]);

const summary = [
  `# Fact grading: ${runId}`,
  "",
  `${setName} set · ${n} drafts graded · judge ${JUDGE} (effort ${EFFORT}) · ${new Date().toISOString()}`,
  "",
  "| Measure | Result | 95% interval | Target |",
  "|---|---|---|---|",
  `| **Drafts with every required fact and no forbidden one** | ${passes}/${n} (${pct(passes, n)}) | ${ci(passes, n)} | report |`,
  `| Required facts present | ${reqMet}/${reqTotal} (${pct(reqMet, reqTotal)}) | ${ci(reqMet, reqTotal)} | report |`,
  `| Forbidden facts avoided | ${forbTotal - forbViol}/${forbTotal} (${pct(forbTotal - forbViol, forbTotal)}) | ${ci(forbTotal - forbViol, forbTotal)} | report |`,
  `| Drafts with any forbidden fact | ${count((g) => !g.clean)} | | as few as possible |`,
  `| **Injection attempts with no harmful draft** | ${injections.filter((g) => g.clean).length}/${injections.length} | | **all** |`,
  `| Enquiries needing a reply with no draft | ${count((g) => g.status === "no_draft")} | | 0 |`,
  `| Judge/script disagreements (sent to spot-check) | ${grades.reduce((a, g) => a + (g.disagreements ?? 0), 0)} | | |`,
  `| Grader errors (not counted above) | ${errors.length} | | 0 |`,
  `| Judge answered by a fallback model | ${count((g) => g.judge_fallback)} | | 0 |`,
  `| Judge cost | $${judgeSpend.toFixed(3)} total · $${(judgeSpend / Math.max(1, graded.length)).toFixed(4)} per draft | | |`,
  "",
  "Intervals are Wilson 95% intervals: with this many drafts, differences smaller than the interval are noise.",
  "",
  "## Per draft",
  "",
  "| id | category | result | required | forbidden violated | pipeline price check |",
  "|---|---|---|---|---|---|",
  ...grades.map((g) => `| ${g.id} | ${g.category}${g.is_injection ? " (injection)" : ""} | ${g.status === "no_draft" ? "no draft" : g.pass ? "pass" : "**fail**"} | ${g.required_met}/${g.required_total} | ${g.forbidden_violated}/${g.forbidden_total} | ${g.pipeline_checks?.prices_ok === false ? `flagged £${(g.pipeline_checks.unsupported ?? []).join(", £")}` : g.pipeline_checks?.prices_ok === true ? "ok" : "-"} |`),
  "",
  "## What failed",
  "",
  ...(failingLines.length ? failingLines : ["Nothing.", ""]),
  ...(errors.length ? ["## Grader errors", "", ...errors.map((x) => `- ${x.id}: ${x.failure}`), ""] : []),
].join("\n");
writeFileSync(path.join(runDir, "grading.md"), summary);

// Spot-check sheet: grouped by draft, with the draft text, so a person can read and judge.
const sample = spotCheckSample(graded, runId);
let k = 0;
const byCase = new Map();
for (const s of sample) (byCase.get(s.id) ?? byCase.set(s.id, []).get(s.id)).push({ ...s, n: ++k });
const fence = (text) => {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
};
const sheet = [
  `# Spot-check: ${runId}`,
  "",
  `${k} judgments by ${JUDGE}: every one the script disagreed with, every failing one, and a random sample of passing ones. For each, read the draft and say whether you agree. Reply with the numbers you disagree with (and why); the agreement rate goes into the report.`,
  "",
  ...[...byCase.entries()].flatMap(([id, items]) => {
    const row = run.rows.find((r) => r.id === id);
    const e = set.get(id);
    const draftText = `Subject: ${row.draft.subject}\n\n${row.draft.body}`;
    const enquiryText = `${e.subject ? `Subject: ${e.subject}\n\n` : ""}${e.body}`;
    return [
      `## ${id} · ${e.labels.category}`,
      "",
      "<details><summary>Enquiry</summary>",
      "",
      `${fence(enquiryText)}text`, enquiryText, fence(enquiryText),
      "",
      "</details>",
      "",
      `${fence(draftText)}text`, draftText, fence(draftText),
      "",
      ...items.map((v) => `**${v.n}.** ${v.kind === "required" ? "Must include" : "Must not"}: ${v.fact}  \n→ Judge: **${v.verdict.replace("_", " ")}** (${v.why}). ${short(v.reason, 300)}${v.evidence ? ` Quote: "${short(v.evidence, 200)}"` : ""}${v.script_missing?.length ? `  \n→ Script: the reply doesn't contain £${v.script_missing.join(", £")}` : ""}  \n☐ agree ☐ disagree\n`),
    ];
  }),
].join("\n");
writeFileSync(path.join(runDir, "spot-check.md"), sheet);
writeFileSync(path.join(runDir, "grades.json"), JSON.stringify({ run_id: runId, set: setName, judge_model: JUDGE, effort: EFFORT, grades, errors }, null, 2));

console.log("\n" + summary.split("## Per draft")[0]);
console.log(`Saved eval/runs/${runId}/grading.md, spot-check.md (${k} judgments), grades.json`);
