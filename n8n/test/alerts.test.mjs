import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURES,
  REPEAT_WINDOW_MS,
  buildAlerts,
  describeWorkflowError,
  errorKey,
  errorText,
  failureAlert,
  failureAlertMessage,
  throttle,
} from "../src/lib/alerts.mjs";

// What n8n 2.46's Error Trigger outputs (shapes observed live, values made up).
const execError = {
  execution: {
    id: "4512", url: "http://localhost:5678/workflow/abc/executions/4512", mode: "webhook", lastNodeExecuted: "Save draft + audit",
    error: { name: "NodeOperationError", level: "error", message: "Connection terminated unexpectedly", description: null, stack: "Error: at secret/path.js:1" },
  },
  workflow: { id: "PjOy1t26HCdg0Rk6", name: "Harbourline · Draft reply" },
};
// The caller of a sub-workflow that failed: its error names the sub-execution.
const callerError = {
  execution: { id: "4511", mode: "webhook", lastNodeExecuted: "Draft reply (form)", error: { executionId: "4512", workflowId: "PjOy1t26HCdg0Rk6", message: "Connection terminated unexpectedly", stack: "" } },
  workflow: { id: "Gk6d308aTSRMeB0O", name: "Harbourline · Intake (form + Gmail)" },
};
const triggerError = {
  trigger: { mode: "trigger", error: { message: "Request failed with status code 401", name: "NodeApiError" } },
  workflow: { id: "Gk6d308aTSRMeB0O", name: "Harbourline · Intake (form + Gmail)" },
};

test("error text is readable whatever a node put in its error field", () => {
  assert.equal(errorText("boom"), "boom");
  assert.equal(errorText(null), "unknown error");
  assert.equal(errorText({ message: "Bad request", description: "invalid_blocks" }), "Bad request: invalid_blocks");
  assert.equal(errorText({ message: "same", description: "same" }), "same");
  assert.equal(errorText({ code: 7 }), '{"code":7}');
});

test("handled failures carry what a person needs; test enquiries never alert", () => {
  const enquiry = { id: "e1", sender_name: "Ann", sender_email: "ann@example.com", source: "webform", subject: "Leak", body: "x".repeat(900), is_test: false };
  const a = failureAlert("classification_failed", { enquiry, error: { message: "overloaded" }, workflow: "Harbourline · Classify enquiry", execution_id: 77 });
  assert.equal(a.alert, "classification_failed");
  assert.equal(a.enquiry_id, "e1");
  assert.equal(a.error, "overloaded");
  assert.equal(a.execution_id, "77");
  assert.equal(a.body.length, 600);
  assert.equal(failureAlert("draft_failed", { enquiry: { ...enquiry, is_test: true } }), null);
  assert.equal(failureAlert("draft_failed", { enquiry: { ...enquiry, is_test: "true" } }), null);
  assert.throws(() => failureAlert("nope", { enquiry }), /unknown failure kind/);
  for (const k of Object.keys(FAILURES)) assert.ok(failureAlert(k, { enquiry }), k);
});

test("execution and trigger errors are both understood", () => {
  const e = describeWorkflowError(execError);
  assert.deepEqual(e, { workflow: "Harbourline · Draft reply", node: "Save draft + audit", message: "Connection terminated unexpectedly", execution_id: "4512", mode: "webhook", retry_of: null, from_sub_execution: null });
  assert.equal(describeWorkflowError(callerError).from_sub_execution, "4512");
  const t = describeWorkflowError(triggerError);
  assert.equal(t.node, "trigger");
  assert.equal(t.execution_id, null);
  assert.equal(t.message, "Request failed with status code 401");
  assert.equal(describeWorkflowError({}).message, "unknown error");
});

test("repeats of the same error are muted for the window, then reported with a count", () => {
  const key = errorKey(describeWorkflowError(execError));
  const t0 = 1_000_000;
  let r = throttle({}, key, t0);
  assert.equal(r.send, true);
  r = throttle(r.state, key, t0 + 60_000);
  assert.equal(r.send, false);
  r = throttle(r.state, key, t0 + 120_000);
  assert.equal(r.send, false);
  assert.equal(throttle(r.state, "other", t0 + 120_000).send, true, "a different error is not muted");
  r = throttle(r.state, key, t0 + REPEAT_WINDOW_MS + 1);
  assert.equal(r.send, true);
  assert.equal(r.suppressed, 2);
  // Entries older than a day are dropped, so the static data stays small.
  assert.deepEqual(Object.keys(throttle(r.state, "x", t0 + 2 * 86400_000).state), ["x"]);
  // Numbers don't make errors different.
  assert.equal(errorKey({ node: "A", message: "timeout after 30012 ms" }), errorKey({ node: "A", message: "timeout after 30044 ms" }));
});

test("alert messages escape customer text and error text, and contain no links or stack traces", () => {
  const evil = { ...execError, execution: { ...execError.execution, error: { message: "<!channel> <https://evil.example|click> failed" } } };
  const { messages } = buildAlerts("C1", [evil], {}, 0);
  const json = JSON.stringify(messages);
  assert.ok(!json.includes("<!channel>"));
  assert.ok(!json.includes("<https://"));
  assert.ok(!json.includes("localhost:5678"), "no execution URL");
  assert.ok(!json.includes("secret/path"), "no stack trace");
  assert.match(json, /Draft reply\* failed at \*Save draft \+ audit/);
  assert.match(json, /Execution `4512`/);

  const m = failureAlertMessage("C1", failureAlert("send_failed", {
    enquiry: { sender_name: "Bob <!here>", sender_email: "bob@example.com", source: "email", subject: "Re: boiler" },
    enquiry_id: "e2", error: "Gmail returned no message id", by: "Sam", workflow: "Harbourline · Slack interactions", execution_id: "9",
  }));
  const mj = JSON.stringify(m);
  assert.equal(m.channel, "C1");
  assert.ok(!mj.includes("<!here>"));
  assert.match(mj, /Approved reply was not sent/);
  assert.match(mj, /Approved by\*\\nSam/);
  assert.match(mj, /Enquiry `e2`/);
  assert.equal(m.unfurl_links, false);
});

test("buildAlerts throttles workflow errors but always posts handled failures", () => {
  const failure = failureAlert("card_failed", { enquiry: { id: "e3" }, error: "invalid_blocks" });
  let r = buildAlerts("C1", [execError], {}, 1000);
  assert.equal(r.messages.length, 1);
  r = buildAlerts("C1", [execError, failure, failure], r.state, 2000);
  assert.equal(r.messages.length, 2, "repeat muted, both handled failures posted");
  assert.ok(r.messages.every((m) => m.blocks[0].text.text.includes("Approval card not posted")));
  r = buildAlerts("C1", [{ something: "else" }], r.state, 3000);
  assert.match(JSON.stringify(r.messages), /Unrecognised alert input/);
});

test("one failure inside a sub-workflow gives one alert, and a duplicate-only run saves nothing", () => {
  const caller = buildAlerts("C1", [callerError], { kept: { last: 5, suppressed: 0 } }, 1000);
  assert.equal(caller.messages.length, 0, "the sub-workflow reports it");
  assert.equal(caller.changed, false, "must not overwrite a parallel run's memory");
  const sub = buildAlerts("C1", [execError], {}, 1000);
  assert.equal(sub.messages.length, 1);
  assert.equal(sub.changed, true);
  assert.match(JSON.stringify(buildAlerts("C1", [{ ...execError, execution: { ...execError.execution, mode: "integrated" } }], {}, 0).messages), /called by another workflow/);
});
