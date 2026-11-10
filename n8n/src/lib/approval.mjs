// Approval step: Slack request verification, interaction routing, the approval card and modals, and
// the email/records/calendar plan after a decision. Pure functions (no Node built-ins: n8n's Code
// sandbox blocks `crypto`), inlined into Code nodes by n8n/build.mjs and unit-tested in n8n/test.
// The build inlines slack.mjs before this file (imports are stripped) and adds the channel constants.
import { slackEscape } from "./slack.mjs";

// ---------------------------------------------------------------------------------------------
// SHA-256 / HMAC-SHA256 (FIPS 180-4, RFC 2104), so Slack signatures can be checked without `crypto`.

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

export function utf8Bytes(text) {
  return Uint8Array.from(Buffer.from(String(text), "utf8"));
}

export function sha256(bytes) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const w = new Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  H.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

export function hmacSha256(keyBytes, messageBytes) {
  let key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes;
  const block = new Uint8Array(64);
  block.set(key);
  const inner = new Uint8Array(64 + messageBytes.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = block[i] ^ 0x36;
    outer[i] = block[i] ^ 0x5c;
  }
  inner.set(messageBytes, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Comparison that takes the same time whatever the input, so the signature can't be guessed byte by byte. */
function sameText(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Slack request signing: signature = "v0=" + hex(HMAC-SHA256(secret, "v0:" + timestamp + ":" + raw body)).
 * Requests older than five minutes are refused, so a captured request can't be replayed.
 */
export function verifySlackSignature({ rawBody, timestamp, signature, secret, nowSeconds }) {
  if (!secret || secret.startsWith("__SECRET__")) return { ok: false, reason: "signing secret not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing Slack signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) return { ok: false, reason: "stale or invalid timestamp" };
  const expected = "v0=" + hex(hmacSha256(utf8Bytes(secret), utf8Bytes(`v0:${timestamp}:${rawBody}`)));
  return sameText(expected, signature) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------------------------------------
// Interactions

export const ACTIONS = { approve: "harbourline_approve", edit: "harbourline_edit", reject: "harbourline_reject", rescue: "harbourline_rescue" };
export const VIEWS = { edit: "harbourline_edit_submit", reject: "harbourline_reject_submit" };

/**
 * Raw x-www-form-urlencoded body -> the Slack payload object. Decoded by hand: n8n's Code sandbox has
 * no URLSearchParams.
 */
export function parseInteraction(rawBody) {
  let payload = null;
  for (const pair of String(rawBody).split("&")) {
    const eq = pair.indexOf("=");
    const key = decodeURIComponent((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " "));
    if (key === "payload") payload = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  if (!payload) throw new Error("no Slack payload in the request body");
  return JSON.parse(payload);
}

const who = (user) => ({ id: user?.id ?? null, name: user?.name || user?.username || user?.id || "unknown" });

/** What a Slack interaction asks us to do. Anything unrecognised is ignored. */
export function routeInteraction(p) {
  const user = who(p.user);
  if (p.type === "block_actions") {
    const action = p.actions?.[0];
    let value = {};
    try {
      value = JSON.parse(action?.value ?? "{}");
    } catch {}
    const base = { user, draft_id: value.d ?? null, channel: p.container?.channel_id ?? p.channel?.id ?? null, ts: p.container?.message_ts ?? p.message?.ts ?? null, trigger_id: p.trigger_id ?? null };
    // "Process" on a spam-folder alert (housekeeping): carries a Gmail message id, not a draft.
    if (action?.action_id === ACTIONS.rescue) {
      const gmailId = String(value.g ?? "");
      if (!/^[0-9a-f]{8,24}$/.test(gmailId)) return { kind: "ignore", reason: "bad gmail id" };
      return { kind: "rescue", user, gmail_id: gmailId, channel: base.channel, ts: base.ts };
    }
    if (!base.draft_id) return { kind: "ignore", reason: "no draft id" };
    if (action.action_id === ACTIONS.approve) return { kind: "approve", ...base };
    if (action.action_id === ACTIONS.edit) return { kind: "edit_open", ...base, subject: value.s ?? null, body: value.b ?? null };
    if (action.action_id === ACTIONS.reject) return { kind: "reject_open", ...base };
    return { kind: "ignore", reason: `unknown action ${action?.action_id}` };
  }
  if (p.type === "view_submission") {
    let meta = {};
    try {
      meta = JSON.parse(p.view?.private_metadata ?? "{}");
    } catch {}
    const values = p.view?.state?.values ?? {};
    const field = (block, action) => values[block]?.[action]?.value ?? null;
    const base = { user, draft_id: meta.d ?? null, channel: meta.c ?? null, ts: meta.t ?? null };
    if (!base.draft_id) return { kind: "ignore", reason: "no draft id" };
    if (p.view.callback_id === VIEWS.edit) {
      return { kind: "edit_submit", ...base, subject: (field("subject", "value") ?? "").trim(), body: (field("body", "value") ?? "").trim() };
    }
    if (p.view.callback_id === VIEWS.reject) return { kind: "reject_submit", ...base, reason: (field("reason", "value") ?? "").trim() };
  }
  return { kind: "ignore", reason: `unhandled ${p.type}` };
}

// ---------------------------------------------------------------------------------------------
// Approval card

const CATEGORY_LABEL = {
  new_job_request: "New job",
  quote_request: "Quote request",
  emergency: "EMERGENCY",
  complaint: "Complaint",
  existing_customer_followup: "Follow-up",
  spam: "Spam",
};
const URGENCY_ICON = { emergency: "🚨", high: "🟠", normal: "🟢", low: "⚪" };
const MAX_SECTION = 2900;

function ukTime(iso) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

/** Slack sections hold up to 3000 characters; long drafts are cut with a pointer to Edit. */
function draftSections(body) {
  const text = slackEscape(body, 100000);
  if (text.length <= MAX_SECTION) return [{ type: "section", block_id: "draft_body", text: { type: "mrkdwn", text } }];
  return [
    { type: "section", block_id: "draft_body", text: { type: "mrkdwn", text: text.slice(0, MAX_SECTION) + "…" } },
    { type: "context", block_id: "draft_body_more", elements: [{ type: "mrkdwn", text: "_Draft shortened here: open *Edit* to see and change the full text._" }] },
  ];
}

/** The Edit button carries the draft so the modal opens instantly (Slack allows 3 s); long drafts load from the database. */
export function editButtonValue(draftId, subject, body) {
  const full = JSON.stringify({ d: draftId, s: subject, b: body });
  return full.length <= 1950 ? full : JSON.stringify({ d: draftId });
}

/**
 * chat.postMessage body for the approval card. `row` is the joined draft + enquiry row.
 */
export function approvalCard(channel, row) {
  const c = row.classification ?? {};
  const checks = row.grounding_check ?? {};
  const prices = checks.prices;
  const contacts = checks.contacts;
  const slots = Array.isArray(row.proposed_slot) ? row.proposed_slot : [];
  const sender = [row.sender_name, row.sender_email, row.sender_phone].filter(Boolean).map((x) => slackEscape(x, 120)).join(" · ");
  const customer = row.customer_id ? `✅ Verified customer${row.customer_name ? `: ${slackEscape(row.customer_name, 80)}` : ""} (${row.customer_id})` : "New or unverified sender";
  const checkLine = [
    prices ? (prices.ok ? `✅ Prices grounded${prices.amounts?.length ? ` (£${prices.amounts.join(", £")})` : " (none quoted)"}` : `❌ Unverified price(s): £${prices.unsupported.join(", £")}`) : "Prices not checked",
    contacts ? (contacts.ok ? "✅ No one else's contact details" : "❌ Unexpected contact details in the draft") : "",
  ].filter(Boolean).join("   ");
  const reasons = String(row.review_reason ?? "").split("; ").filter(Boolean);
  const urgent = c.urgency === "emergency";
  return {
    channel,
    text: `${URGENCY_ICON[c.urgency] ?? ""} ${CATEGORY_LABEL[c.category] ?? c.category}: ${slackEscape(c.summary, 150)}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `${URGENCY_ICON[c.urgency] ?? "📨"} ${CATEGORY_LABEL[c.category] ?? "Enquiry"} · ${c.urgency ?? ""} urgency`.slice(0, 150), emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `*${slackEscape(c.summary, 300)}*` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*From*\n${sender || "unknown"}` },
          { type: "mrkdwn", text: `*Received*\n${ukTime(row.received_at)} by ${sourceLabel(row.source)}` },
          { type: "mrkdwn", text: `*Customer*\n${customer}` },
          { type: "mrkdwn", text: `*Postcode*\n${slackEscape(c.postcode || "not given", 20)}` },
        ],
      },
      ...(c.injection_suspected
        ? [{ type: "section", text: { type: "mrkdwn", text: `:shield: *Possible prompt injection, ignored by the AI:* ${slackEscape(c.injection_evidence ?? "see the enquiry", 300)}` } }]
        : []),
      ...(reasons.length
        ? [{ type: "section", text: { type: "mrkdwn", text: `:warning: *Needs your decision*\n${reasons.map((r) => `• ${slackEscape(r, 400)}`).join("\n")}` } }]
        : []),
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Draft reply* to ${slackEscape(row.sender_email || "the sender", 120)}\n*Subject:* ${slackEscape(row.subject, 200)}` } },
      ...draftSections(row.body),
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: checkLine },
          ...(slots.length ? [{ type: "mrkdwn", text: `🗓️ On approval, tentative holds: ${slots.map((s) => slackEscape(s.label, 40)).join("; ")}` }] : []),
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `_AI notes: ${slackEscape(row.reasoning, 600)}_` }] },
      {
        type: "actions",
        block_id: "decision",
        elements: [
          {
            type: "button", action_id: ACTIONS.approve, style: "primary", text: { type: "plain_text", text: urgent ? "Approve & send now" : "Approve & send" },
            value: JSON.stringify({ d: row.draft_id }),
            confirm: {
              title: { type: "plain_text", text: "Send this reply?" },
              text: { type: "mrkdwn", text: `It will be emailed to ${slackEscape(row.sender_email || "the sender", 120)}.` },
              confirm: { type: "plain_text", text: "Send" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
          { type: "button", action_id: ACTIONS.edit, text: { type: "plain_text", text: "Edit" }, value: editButtonValue(row.draft_id, row.subject, row.body) },
          { type: "button", action_id: ACTIONS.reject, style: "danger", text: { type: "plain_text", text: "Reject" }, value: JSON.stringify({ d: row.draft_id }) },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: `Draft v${row.version ?? 1} · ${row.message_id} · Harbourline is a fictional demo company` }] },
    ],
  };
}

/** Card for an enquiry the AI couldn't draft: no buttons, a person replies directly. */
export function manualCard(channel, row, reasons) {
  const c = row.classification ?? {};
  return {
    channel,
    text: `Manual reply needed: ${slackEscape(c.summary ?? row.subject ?? "enquiry", 150)}`,
    unfurl_links: false,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "✋ Manual reply needed", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `*${slackEscape(c.summary ?? row.subject ?? "Enquiry", 300)}*\nFrom ${slackEscape([row.sender_name, row.sender_email].filter(Boolean).join(" · "), 200)}` } },
      { type: "section", text: { type: "mrkdwn", text: `>${slackEscape(row.body, 1500).replace(/\n+/g, "\n>")}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Why: ${slackEscape(reasons.join("; ") || "no draft was produced", 500)}` }] },
    ],
  };
}

/**
 * chat.update body: the card keeps its summary, the buttons are replaced by the outcome, and for an
 * edited reply the draft is replaced by the text that was actually sent.
 */
export function outcomeCard(channel, ts, card, outcome) {
  const keep = [];
  for (const b of card?.blocks ?? []) {
    if (b.type === "actions" || b.block_id === "decision") continue;
    if (outcome.edited && String(b.block_id ?? "").startsWith("draft_body")) {
      if (b.block_id === "draft_body") {
        keep.push({ type: "section", block_id: "sent_body", text: { type: "mrkdwn", text: `*Sent text (edited):*\n${slackEscape(outcome.final_body, 2800)}` } });
      }
      continue;
    }
    keep.push(b);
  }
  const icon = { sent: "✅", simulated: "✅", rejected: "🚫", failed: "⚠️" }[outcome.status] ?? "ℹ️";
  const text = outcome.status === "rejected"
    ? `${icon} *Rejected* by ${slackEscape(outcome.by, 80)}${outcome.reason ? `: ${slackEscape(outcome.reason, 300)}` : ""}`
    : outcome.status === "failed"
      ? `${icon} *Approved by ${slackEscape(outcome.by, 80)}, but sending failed:* ${slackEscape(outcome.error ?? "unknown error", 300)}. Please reply manually.`
      : `${icon} *${outcome.edited ? "Edited and sent" : "Sent"}* by ${slackEscape(outcome.by, 80)}${outcome.status === "simulated" ? " (simulated: test address, nothing emailed)" : ""}${outcome.holds ? ` · ${outcome.holds} tentative hold(s) added for ${HOLD_DAYS} days` : ""}${outcome.customer_created ? " · new customer record" : ""}${outcome.job_created ? " · job logged" : ""}`;
  return {
    channel,
    ts,
    text: text.replace(/\*/g, ""),
    blocks: [...keep, { type: "section", block_id: "outcome", text: { type: "mrkdwn", text } }],
  };
}

export function editModal(draftId, channel, ts, subject, body) {
  return {
    type: "modal",
    callback_id: VIEWS.edit,
    private_metadata: JSON.stringify({ d: draftId, c: channel, t: ts }),
    title: { type: "plain_text", text: "Edit reply" },
    submit: { type: "plain_text", text: "Send edited reply" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "subject", label: { type: "plain_text", text: "Subject" }, element: { type: "plain_text_input", action_id: "value", initial_value: String(subject ?? "").slice(0, 150), max_length: 150 } },
      { type: "input", block_id: "body", label: { type: "plain_text", text: "Reply" }, element: { type: "plain_text_input", action_id: "value", multiline: true, initial_value: String(body ?? "").slice(0, 3000), max_length: 3000 } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Sending is immediate. Your edit is saved with the original draft, to improve the prompts later." }] },
    ],
  };
}

export function rejectModal(draftId, channel, ts) {
  return {
    type: "modal",
    callback_id: VIEWS.reject,
    private_metadata: JSON.stringify({ d: draftId, c: channel, t: ts }),
    title: { type: "plain_text", text: "Reject draft" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "reason", label: { type: "plain_text", text: "Why? (kept in the audit log)" }, optional: true, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 1000 } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Nothing is sent. The enquiry is closed as rejected." }] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// After a decision

/** Domains that can never receive mail (RFC 2606 / 6761): approving a reply to them is simulated, not sent. */
export function isReservedAddress(email) {
  const domain = String(email ?? "").toLowerCase().split("@")[1] ?? "";
  return !domain || /(^|\.)(example|test|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org|co\.uk)$/.test(domain);
}

/** How the reply goes out. Only ever to the stored sender address. */
export function emailPlan(row, subject, body) {
  const to = String(row.sender_email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { mode: "none", error: "no valid sender email address" };
  if (!String(body ?? "").trim()) return { mode: "none", error: "empty reply" };
  if (isReservedAddress(to)) return { mode: "simulated", to, subject, body };
  if (row.source === "email" && String(row.message_id).startsWith("gmail:")) {
    return { mode: "reply", to, gmail_id: String(row.message_id).slice(6), subject, body };
  }
  return { mode: "send", to, subject, body };
}

export function splitName(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "Unknown", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts.at(-1) };
}

export const JOB_CATEGORIES = ["new_job_request", "quote_request", "emergency"];

/** Where an enquiry came from, for the people reading the card. */
export function sourceLabel(source) {
  return source === "email" ? "email" : source === "demo" ? "the live demo" : "web form";
}

/** How long a tentative hold is kept before housekeeping releases it (unless someone confirms it). */
export const HOLD_DAYS = 3;

/**
 * What a hold is called on the calendar. The demo page shows the bookings calendar publicly, so a
 * title never includes a name or anything the sender typed: only the catalogue service (a fixed list)
 * or the category, and the postcode district if it looks like one. Example: "boiler service · BS31".
 */
export function holdTitle(classification) {
  const c = classification ?? {};
  const id = (Array.isArray(c.service_ids) ? c.service_ids : []).find((x) => /^svc_[a-z0-9_]+$/.test(String(x)));
  const what = id ? id.slice(4).replace(/_/g, " ") : (CATEGORY_LABEL[c.category] ?? "enquiry").toLowerCase();
  const outward = String(c.postcode ?? "").toUpperCase().trim().split(/\s+/)[0];
  const district = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/.test(outward) ? outward : "area unknown";
  return `${what} · ${district}`;
}

/** Google Calendar event bodies for tentative holds on the slots the reply offered. */
export function holdEvents(slots, row, timezone = "Europe/London", nowMs = Date.now()) {
  const expires = new Date(nowMs + HOLD_DAYS * 24 * 3600 * 1000);
  const until = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(expires);
  if (!Array.isArray(slots)) return [];
  const title = holdTitle(row.classification);
  return slots
    .filter((s) => s?.start && s?.end && !Number.isNaN(Date.parse(s.start)) && !Number.isNaN(Date.parse(s.end)))
    .slice(0, 3)
    .map((s) => ({
      summary: `HOLD (tentative): ${title}`,
      description: `Offered to the customer in an approved reply, not yet confirmed. Enquiry ${row.message_id}.\nReleased automatically on ${until} unless confirmed. To keep it, take "HOLD" out of the title.`,
      start: { dateTime: s.start, timeZone: timezone },
      end: { dateTime: s.end, timeZone: timezone },
      status: "tentative",
      transparency: "opaque",
      colorId: "5",
      extendedProperties: { private: { harbourlineHold: String(row.enquiry_id), harbourlineHoldExpires: expires.toISOString() } },
    }));
}
