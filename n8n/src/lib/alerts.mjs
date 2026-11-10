// Operational alerts for #alerts. Two sources:
//   1. Workflow errors: n8n runs the "Alerts" workflow's Error Trigger when any Harbourline workflow
//      fails (settings.errorWorkflow), e.g. a database outage or a bug in a Code node.
//   2. Handled failures: steps that fail without stopping the workflow (Claude couldn't classify, no
//      draft, Slack refused the card, the email didn't send, calendar holds failed). These only reached
//      the audit log before; now the workflow also calls the Alerts workflow with a small payload.
// Pure functions: inlined into n8n Code nodes by n8n/build.mjs, together with slack.mjs (slackEscape).
// Alerts never contain links or secrets, and everything from customers or error messages is escaped.
import { slackEscape } from "./slack.mjs";

export const FAILURES = {
  classification_failed: {
    title: "Enquiry could not be classified",
    action: "No reply was drafted and nothing was posted in #enquiries. Please read it and reply by hand.",
  },
  draft_failed: {
    title: "No draft for an enquiry",
    action: "Drafting failed, so it will appear in #enquiries as a manual-reply card.",
  },
  card_failed: {
    title: "Approval card not posted",
    action: "Slack refused the card, so this enquiry is not in #enquiries. The draft is saved; reply by hand.",
  },
  send_failed: {
    title: "Approved reply was not sent",
    action: "The enquiry is marked failed. Send the reply by hand.",
  },
  holds_failed: {
    title: "Calendar holds not created",
    action: "The reply was sent, but some offered slots are not held in the calendar. Add them by hand.",
  },
};

/** Readable text for whatever an n8n node put in its error field (string, Error-like object, or nothing). */
export function errorText(error) {
  if (error === null || error === undefined || error === "") return "unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const parts = [error.message, error.description].filter((x) => typeof x === "string" && x);
    if (parts.length) return [...new Set(parts)].join(": ");
    try {
      return JSON.stringify(error);
    } catch {
      return "unknown error";
    }
  }
  return String(error);
}

const isTest = (e) => e?.is_test === true || e?.is_test === "true";

/**
 * The payload a workflow sends to the Alerts workflow for a handled failure, or null when no alert is
 * due. Test enquiries never alert: evaluation runs report their own failures.
 */
export function failureAlert(kind, { enquiry, enquiry_id, error, workflow, execution_id, by } = {}) {
  if (!FAILURES[kind]) throw new Error(`unknown failure kind: ${kind}`);
  if (isTest(enquiry)) return null;
  const e = enquiry ?? {};
  return {
    alert: kind,
    enquiry_id: enquiry_id ?? e.id ?? null,
    error: errorText(error).slice(0, 1000),
    workflow: workflow ?? null,
    execution_id: execution_id === undefined || execution_id === null ? null : String(execution_id),
    by: by ?? null,
    sender_name: e.sender_name ?? null,
    sender_email: e.sender_email ?? null,
    source: e.source ?? null,
    subject: e.subject ?? null,
    body: e.body ? String(e.body).slice(0, 600) : null,
  };
}

/** What n8n's Error Trigger outputs, in one shape: an execution error, or a trigger that failed to poll. */
export function describeWorkflowError(data) {
  const exec = data?.execution ?? null;
  const err = exec?.error ?? data?.trigger?.error ?? {};
  const hasText = Boolean(err.message || err.description);
  return {
    workflow: data?.workflow?.name ?? "Unknown workflow",
    node: err.node?.name ?? exec?.lastNodeExecuted ?? (data?.trigger ? "trigger" : "unknown step"),
    message: errorText(hasText ? { message: err.message, description: err.description } : null),
    execution_id: exec?.id === undefined || exec?.id === null ? null : String(exec.id),
    mode: exec?.mode ?? data?.trigger?.mode ?? null,
    retry_of: exec?.retryOf ?? null,
    // A caller that failed because its sub-workflow failed gets the sub-execution's id in the error.
    // The sub-workflow raises its own alert (it has the same error workflow), so this one is a duplicate.
    from_sub_execution: err.executionId && String(err.executionId) !== String(exec?.id) ? String(err.executionId) : null,
  };
}

const MODES = { integrated: "called by another workflow", webhook: "web request", trigger: "trigger", retry: "retry", manual: "manual run" };

/**
 * Repeat suppression for workflow errors (a poller that fails every minute must not post 60 alerts an
 * hour). The key ignores digits, so "timeout after 30012 ms" and "after 30044 ms" count as the same.
 * state: { [key]: { last: ms, suppressed: n } }, kept in the Alerts workflow's static data.
 */
export const REPEAT_WINDOW_MS = 30 * 60 * 1000;
export const errorKey = (info) => `${info.node}|${info.message}`.replace(/\d+/g, "#").slice(0, 300);

export function throttle(state, key, nowMs, windowMs = REPEAT_WINDOW_MS) {
  const next = {};
  for (const [k, v] of Object.entries(state ?? {})) if (nowMs - v.last < 24 * 3600 * 1000) next[k] = v;
  const prev = next[key];
  if (prev && nowMs - prev.last < windowMs) {
    next[key] = { last: prev.last, suppressed: prev.suppressed + 1 };
    return { send: false, suppressed: 0, state: next };
  }
  next[key] = { last: nowMs, suppressed: 0 };
  return { send: true, suppressed: prev?.suppressed ?? 0, state: next };
}

const shortName = (workflow) => String(workflow ?? "").replace(/^Harbourline · /, "");
const footer = (parts) => ({ type: "context", elements: [{ type: "mrkdwn", text: parts.filter(Boolean).join(" · ") }] });

/** chat.postMessage body for a workflow error. */
export function errorAlertMessage(channel, info, suppressed = 0) {
  const where = `*${slackEscape(shortName(info.workflow), 100)}* failed at *${slackEscape(info.node, 100)}*`;
  return {
    channel,
    text: `Workflow error: ${slackEscape(shortName(info.workflow), 100)} failed at ${slackEscape(info.node, 100)}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "⚠️ Workflow error", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `${where}\n>${slackEscape(info.message, 700).replace(/\n+/g, "\n>")}` } },
      footer([
        info.execution_id ? `Execution \`${slackEscape(info.execution_id, 30)}\` (n8n → Executions)` : "The trigger itself failed (no execution)",
        info.mode ? slackEscape(MODES[info.mode] ?? `mode ${info.mode}`, 40) : null,
        info.retry_of ? `retry of \`${slackEscape(info.retry_of, 30)}\`` : null,
        suppressed ? `${suppressed} repeat(s) of this error were not posted` : null,
        `Repeats are muted for ${REPEAT_WINDOW_MS / 60000} min`,
      ]),
    ],
  };
}

/** chat.postMessage body for a handled failure. */
export function failureAlertMessage(channel, p) {
  const f = FAILURES[p.alert] ?? { title: "Pipeline problem", action: "" };
  const from = [p.sender_name, p.sender_email].filter(Boolean).map((x) => slackEscape(x, 120)).join(" · ") || "unknown sender";
  const fields = [
    { type: "mrkdwn", text: `*From*\n${from}` },
    { type: "mrkdwn", text: `*Received by*\n${p.source === "email" ? "email" : p.source === "webform" ? "web form" : "unknown"}` },
  ];
  if (p.subject) fields.push({ type: "mrkdwn", text: `*Subject*\n${slackEscape(p.subject, 150)}` });
  if (p.by) fields.push({ type: "mrkdwn", text: `*Approved by*\n${slackEscape(p.by, 80)}` });
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `⚠️ ${f.title}`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `${f.action}\n*Error:* ${slackEscape(p.error, 500)}` } },
    { type: "section", fields },
  ];
  if (p.body) blocks.push({ type: "section", text: { type: "mrkdwn", text: `>${slackEscape(p.body, 500).replace(/\n+/g, "\n>")}` } });
  blocks.push(footer([
    p.enquiry_id ? `Enquiry \`${slackEscape(p.enquiry_id, 40)}\`` : null,
    p.workflow ? slackEscape(shortName(p.workflow), 60) : null,
    p.execution_id ? `execution \`${slackEscape(p.execution_id, 30)}\`` : null,
  ]));
  return { channel, text: `${f.title}: ${from}`, unfurl_links: false, unfurl_media: false, blocks };
}

/**
 * Turn the Alerts workflow's input items into Slack messages. Error Trigger items are throttled and
 * duplicates from callers of a failed sub-workflow are dropped; handled failures (one per enquiry,
 * each needing a person) are always posted. `changed` says whether the repeat memory must be saved:
 * a run that changes nothing must not write, or it can overwrite a parallel run's update.
 */
export function buildAlerts(channel, items, state, nowMs) {
  const messages = [];
  let s = state ?? {};
  let changed = false;
  for (const item of items) {
    if (item?.alert) {
      messages.push(failureAlertMessage(channel, item));
    } else if (item?.workflow && (item.execution || item.trigger)) {
      const info = describeWorkflowError(item);
      if (info.from_sub_execution) continue;
      const t = throttle(s, errorKey(info), nowMs);
      s = t.state;
      changed = true;
      if (t.send) messages.push(errorAlertMessage(channel, info, t.suppressed));
    } else {
      messages.push(errorAlertMessage(channel, { workflow: "Alerts", node: "input", message: "Unrecognised alert input", execution_id: null }));
    }
  }
  return { messages, state: s, changed };
}
