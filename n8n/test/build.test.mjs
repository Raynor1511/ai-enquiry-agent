// Structural checks on the generated workflows (no n8n needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WF, WORKFLOWS, nodeReferences } from "../build.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const all = WORKFLOWS.map((w) => w.workflow);
const byName = (wf, name) => wf.nodes.find((n) => n.name === name);

test("every Code node compiles", () => {
  for (const wf of all) {
    for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.code")) {
      assert.doesNotThrow(() => new AsyncFunction(n.parameters.jsCode), `${wf.name} / ${n.name}`);
    }
  }
});

test("every node reference resolves, and the checker really finds references", () => {
  for (const wf of all) {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const r of nodeReferences(wf)) assert.ok(names.has(r), `${wf.name}: $("${r}")`);
  }
  const draft = all.find((w) => w.name === WF.draft);
  assert.ok(nodeReferences(draft).includes("Finalise draft"));
  assert.ok(nodeReferences(draft).includes("Tool results 1"));
});

test("every workflow except Alerts reports its failures to Alerts", () => {
  assert.equal(WORKFLOWS[0].workflow.name, WF.alerts, "Alerts is deployed first");
  for (const wf of all) {
    if (wf.name === WF.alerts) assert.equal(wf.settings.errorWorkflow, undefined, "no loop");
    else assert.equal(wf.settings.errorWorkflow, `__WORKFLOW__${WF.alerts}`, wf.name);
  }
});

test("handled-failure branches run before the result node and can never stop the pipeline", () => {
  const cases = [
    [WF.classify, "Save classification + audit", "Result"],
    [WF.draft, "Save draft + audit", "Draft result"],
    [WF.approval, "Save card + status", "Approval result"],
    [WF.interactions, "Log outcome", "Card to update?"],
  ];
  for (const [name, from, result] of cases) {
    const wf = all.find((w) => w.name === name);
    const targets = wf.connections[from].main[0].map((c) => c.node);
    assert.deepEqual(new Set(targets), new Set(["Failure alert?", result]), name);
    // Execution order v1 runs the topmost branch first, so the sub-workflow's last node is still the result.
    assert.ok(byName(wf, "Failure alert?").position[1] < byName(wf, result).position[1], `${name}: alert branch above`);
    const call = byName(wf, "Alert #alerts");
    assert.equal(call.parameters.options.waitForSubWorkflow, false, name);
    assert.equal(call.onError, "continueRegularOutput", name);
    assert.equal(call.parameters.workflowId.value, `__WORKFLOW__${WF.alerts}`);
  }
});

// Run a generated Code node's code with a stubbed n8n sandbox: $("Node") returns the given outputs.
async function runNode(wfName, nodeName, { nodes = {}, input = [], staticData = {} } = {}) {
  const wf = all.find((w) => w.name === wfName);
  const node = byName(wf, nodeName);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`test gave no output for $("${name}")`);
    return { first: () => ({ json: nodes[name] }), item: { json: nodes[name] } };
  };
  const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
  const fn = new AsyncFunction("$", "$input", "$json", "$workflow", "$execution", "$getWorkflowStaticData", node.parameters.jsCode);
  return fn($, $input, input[0], { name: wf.name }, { id: "900" }, () => staticData);
}
const live = { id: "e1", sender_name: "Ann Lee", sender_email: "ann@example.com", source: "webform", subject: "Leak", body: "Water under the sink", is_test: false };

test("the deployed alert-branch code builds the right payloads from real upstream outputs", async () => {
  // Classify: an error -> alert; no error or a test enquiry -> nothing.
  let out = await runNode(WF.classify, "Failure alert?", { nodes: { "Apply safety rules": { error: "HTTP 529 overloaded", enquiry_id: "e1" }, "Prepare enquiry": { enquiry: live } } });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.alert, "classification_failed");
  assert.equal(out[0].json.workflow, WF.classify);
  assert.equal(out[0].json.execution_id, "900");
  assert.equal(out[0].json.sender_email, "ann@example.com");
  assert.deepEqual(await runNode(WF.classify, "Failure alert?", { nodes: { "Apply safety rules": { error: null, enquiry_id: "e1" }, "Prepare enquiry": { enquiry: live } } }), []);
  assert.deepEqual(await runNode(WF.classify, "Failure alert?", { nodes: { "Apply safety rules": { error: "x", enquiry_id: "e1" }, "Prepare enquiry": { enquiry: { ...live, is_test: true } } } }), []);

  // Draft: no draft -> alert; a draft (even one needing review) -> nothing.
  out = await runNode(WF.draft, "Failure alert?", { nodes: { "Finalise draft": { draft: null, error: "no final answer after 6 turns", enquiry_id: "e1" }, Prepare: { ctx: { enquiry: live } } } });
  assert.equal(out[0].json.alert, "draft_failed");
  assert.equal(out[0].json.error, "no final answer after 6 turns");
  assert.deepEqual(await runNode(WF.draft, "Failure alert?", { nodes: { "Finalise draft": { draft: { body: "Hi" }, enquiry_id: "e1" }, Prepare: { ctx: { enquiry: live } } } }), []);

  // Approval: Slack said no (string error, or the HTTP node's error object) -> alert.
  const row = { enquiry_id: "e1", sender_name: "Ann Lee", sender_email: "ann@example.com", source: "email", subject: "Re: Leak", body: "Water", is_test: false };
  out = await runNode(WF.approval, "Failure alert?", { nodes: { "Card posted": { ok: false, error: "invalid_blocks", enquiry_id: "e1" }, "Load for card": row } });
  assert.equal(out[0].json.alert, "card_failed");
  assert.equal(out[0].json.error, "invalid_blocks");
  out = await runNode(WF.approval, "Failure alert?", { nodes: { "Card posted": { ok: false, error: { message: "timeout of 15000ms exceeded" }, enquiry_id: "e1" }, "Load for card": row } });
  assert.equal(out[0].json.error, "timeout of 15000ms exceeded");
  assert.deepEqual(await runNode(WF.approval, "Failure alert?", { nodes: { "Card posted": { ok: true, enquiry_id: "e1" }, "Load for card": row } }), []);

  // Interactions: send failure and hold failures.
  const after = { ok: false, send: { error: "Gmail returned no message id" }, row: { ...row, is_test: false }, final_subject: "Re: Leak", ctx: { user: { name: "Sam" } } };
  out = await runNode(WF.interactions, "Failure alert?", { nodes: { "After send": after, "Outcome card": { holds_ok: 0, holds_failed: 0, hold_errors: [] } } });
  assert.deepEqual(out.map((o) => o.json.alert), ["send_failed"]);
  assert.equal(out[0].json.by, "Sam");
  out = await runNode(WF.interactions, "Failure alert?", { nodes: { "After send": { ...after, ok: true }, "Outcome card": { holds_ok: 2, holds_failed: 1, hold_errors: ["Forbidden"] } } });
  assert.deepEqual(out.map((o) => o.json.alert), ["holds_failed"]);
  assert.equal(out[0].json.error, "1 of 3 hold(s) failed: Forbidden");
  assert.deepEqual(await runNode(WF.interactions, "Failure alert?", { nodes: { "After send": { ...after, ok: true }, "Outcome card": { holds_ok: 3, holds_failed: 0, hold_errors: [] } } }), []);
});

test("the deployed Alerts code posts, mutes repeats in static data, and fails loudly if Slack refuses", async () => {
  const errorItem = { execution: { id: "7", mode: "trigger", lastNodeExecuted: "New email in inbox", error: { message: "invalid_grant" } }, workflow: { name: WF.intake } };
  const memory = {};
  let out = await runNode(WF.alerts, "Build alerts", { input: [errorItem], staticData: memory });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.message.channel, "__ENV__SLACK_ALERTS_CHANNEL_ID");
  assert.equal(Object.keys(memory.recent_errors).length, 1);
  out = await runNode(WF.alerts, "Build alerts", { input: [errorItem], staticData: memory });
  assert.equal(out.length, 0, "muted");
  const untouched = {};
  await runNode(WF.alerts, "Build alerts", { input: [{ ...errorItem, execution: { ...errorItem.execution, error: { executionId: "6", message: "x" } } }], staticData: untouched });
  assert.deepEqual(untouched, {}, "a duplicate-only run writes nothing");

  await assert.rejects(runNode(WF.alerts, "Posted?", { input: [{ ok: false, error: "channel_not_found" }] }), /Slack refused 1 alert\(s\): channel_not_found/);
  assert.equal((await runNode(WF.alerts, "Posted?", { input: [{ ok: true }] })).length, 1);
});

test("every Postgres query in the workflows is one that db-setup replays as the n8n_writer role", async () => {
  const { SQL } = await import("../build.mjs");
  const known = new Set(Object.values(SQL));
  const queries = all.flatMap((wf) => wf.nodes.filter((n) => n.type === "n8n-nodes-base.postgres").map((n) => [wf.name, n.name, n.parameters.query]));
  assert.ok(queries.length >= 11);
  for (const [wf, node, q] of queries) assert.ok(known.has(q), `${wf} / ${node}: add its query to SQL in n8n/build.mjs and to scripts/lib/n8n-role-check.mjs`);
});
