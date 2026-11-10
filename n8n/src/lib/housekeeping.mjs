// Scheduled housekeeping (Phase 5): release stale calendar holds, look for real enquiries in Gmail's
// Spam folder, and remind people about approval cards that are still waiting.
// Pure functions: inlined into n8n Code nodes by n8n/build.mjs, together with slack.mjs (slackEscape).
import { slackEscape } from "./slack.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ukTime(iso, withEnd) {
  try {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const t = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" });
    return withEnd ? `${f.format(new Date(iso))}–${t.format(new Date(withEnd))}` : f.format(new Date(iso));
  } catch {
    return String(iso);
  }
}

/** "45 min", "5 h", "2 days" */
export function waitedText(ms) {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} days`;
}

// ---------------------------------------------------------------------------------------------
// 1. Tentative holds

/** Holds made before expiry dates were stored on them are released this long after creation. */
export const HOLD_FALLBACK_DAYS = 3;

/**
 * Calendar events (events.list items) that are Harbourline holds past their expiry. A hold is only
 * ever released while it still looks like one: tagged harbourlineHold, status tentative, and a title
 * that still starts with "HOLD". Renaming it (or confirming it) keeps it. Demo bookings are never touched.
 */
export function expiredHolds(events, nowMs) {
  const out = [];
  for (const ev of events ?? []) {
    const tag = ev?.extendedProperties?.private?.harbourlineHold;
    if (!tag || ev.status !== "tentative" || !/^HOLD\b/.test(ev.summary ?? "")) continue;
    const stored = Date.parse(ev.extendedProperties.private.harbourlineHoldExpires ?? "");
    const expires = Number.isNaN(stored) ? Date.parse(ev.created ?? "") + HOLD_FALLBACK_DAYS * DAY : stored;
    if (Number.isNaN(expires) || expires > nowMs) continue;
    out.push({ event_id: ev.id, enquiry_id: UUID.test(tag) ? tag : "", start: ev.start?.dateTime ?? ev.start?.date ?? null, end: ev.end?.dateTime ?? ev.end?.date ?? null, summary: ev.summary });
  }
  return out;
}

/** Released holds grouped by enquiry, for one audit row and one Slack note each. */
export function groupByEnquiry(released) {
  const groups = new Map();
  for (const h of released) {
    const key = h.enquiry_id || "unknown";
    if (!groups.has(key)) groups.set(key, { enquiry_id: h.enquiry_id, holds: [] });
    groups.get(key).holds.push(h);
  }
  return [...groups.values()];
}

/** Thread reply on the enquiry's approval card. */
export function holdsReleasedReply(channel, threadTs, holds) {
  const list = holds.map((h) => slackEscape(ukTime(h.start, h.end), 60)).join("; ");
  return {
    channel,
    thread_ts: threadTs,
    text: `🗓️ Released ${holds.length} tentative hold(s) that weren't confirmed in time: ${list}. Book the customer's chosen time when they reply.`,
    unfurl_links: false,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Gmail's Spam folder

/** Where the next sweep starts: just after the last one, at most 7 days back, 1 day on the first run. */
export function sweepStart(lastMs, nowMs) {
  const first = nowMs - DAY;
  if (!Number.isFinite(lastMs) || lastMs > nowMs) return new Date(first).toISOString();
  return new Date(Math.max(lastMs, nowMs - 7 * DAY)).toISOString();
}

/** Words that suggest a real enquiry for a plumbing and heating business. */
export const BUSINESS_WORDS = [
  "plumber", "plumbing", "boiler", "leak", "leaking", "pipe", "pipes", "heating", "radiator", "radiators", "gas",
  "tap", "taps", "toilet", "shower", "bathroom", "drain", "blocked", "hot water", "cylinder", "burst", "flood",
  "flooding", "quote", "engineer", "appointment", "callout", "call out", "certificate", "landlord",
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalised emails (normalise.fromGmail) from the Spam folder that mention something the business
 * does, best matches first. Everything else is left in Spam unmentioned.
 */
export function spamCandidates(emails, words = BUSINESS_WORDS, max = 10) {
  const patterns = [...new Set(words.map((w) => String(w).toLowerCase().trim()).filter(Boolean))].map((w) => [w, new RegExp(`\\b${escapeRe(w)}\\b`, "i")]);
  const scored = [];
  for (const e of emails) {
    const text = `${e.subject ?? ""}\n${e.body ?? ""}`;
    const matched = patterns.filter(([, re]) => re.test(text)).map(([w]) => w);
    if (matched.length && e.gmail_id) scored.push({ ...e, matched });
  }
  return scored.sort((a, b) => b.matched.length - a.matched.length).slice(0, max);
}

export const RESCUE_ACTION = "harbourline_rescue";

/** chat.postMessage for #alerts: one section per candidate with a "Process" button. */
export function spamAlert(channel, candidates, checked) {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: `📥 Possible enquiries in Spam (${candidates.length})`, emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: "Gmail put these in Spam, but they mention things we do. *Process* sends one through the normal pipeline, so it gets an approval card like any other email. Nothing is sent without approval." } },
  ];
  for (const c of candidates) {
    const from = [c.sender_name, c.sender_email].filter(Boolean).map((x) => slackEscape(x, 100)).join(" · ") || "unknown sender";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${slackEscape(c.subject || "(no subject)", 150)}*\nFrom ${from} · mentions ${slackEscape(c.matched.slice(0, 4).join(", "), 80)}\n>${slackEscape(c.body, 280).replace(/\n+/g, " ")}` },
      accessory: { type: "button", action_id: RESCUE_ACTION, text: { type: "plain_text", text: "Process" }, value: JSON.stringify({ g: c.gmail_id }) },
    });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Checked ${checked} new message(s) in Spam; ${checked - candidates.length} looked like ordinary spam and are not listed.` }] });
  return { channel, text: `${candidates.length} possible enquiry(ies) in the Spam folder`, unfurl_links: false, unfurl_media: false, blocks };
}

/** Thread reply on the spam alert after a person pressed Process. */
export function rescueReply(channel, threadTs, user, classify, approval, moved = true) {
  const by = slackEscape(user?.name ?? "someone", 80);
  let what;
  if (classify?.status === "duplicate") what = "it had already been processed, so nothing new was posted";
  else if (classify?.status === "archived") what = "the classifier agrees it is spam, so nothing was posted; answer it by hand if you disagree";
  else if (classify?.status === "needs_review") what = "it couldn't be classified; see #alerts and answer it by hand";
  else if (approval?.status === "awaiting_approval") what = "an approval card with a draft reply is in #enquiries";
  else if (approval?.status === "manual_reply_card") what = "it's in #enquiries as a manual-reply card";
  else what = `it was processed (status ${slackEscape(approval?.status ?? classify?.status ?? "unknown", 30)})`;
  const where = moved ? "The email was moved to the inbox." : "Couldn't move the email out of Spam; do that in Gmail.";
  return { channel, thread_ts: threadTs, text: `✅ ${by} pressed Process: ${what}. ${where}`, unfurl_links: false };
}

// ---------------------------------------------------------------------------------------------
// 3. Approval reminders

/** Minutes before the first reminder, and between reminders, by urgency. */
export const REMINDERS = {
  emergency: { after: 30, every: 60 },
  high: { after: 60, every: 240 },
  normal: { after: 240, every: 1440 },
  low: { after: 1440, every: 2880 },
};

/** Waiting approval cards (rows from the reminder query) that are due a reminder now. */
export function dueReminders(rows, nowMs) {
  const due = [];
  for (const r of rows ?? []) {
    const posted = Date.parse(r.card_posted_at ?? "");
    if (Number.isNaN(posted) || !r.slack_channel || !r.slack_ts) continue;
    const rule = REMINDERS[r.urgency] ?? REMINDERS.normal;
    const waited = nowMs - posted;
    if (waited < rule.after * MINUTE) continue;
    const last = Date.parse(r.last_reminder_at ?? "");
    if (!Number.isNaN(last) && nowMs - last < rule.every * MINUTE) continue;
    due.push({ ...r, waited_ms: waited });
  }
  return due;
}

/** Thread reply on the waiting card, also shown in the channel so it's seen. */
export function reminderMessage(r) {
  const urgent = r.urgency === "emergency" || r.urgency === "high";
  const icon = r.urgency === "emergency" ? "🚨" : "⏰";
  const who = slackEscape(r.sender_name || "a customer", 80);
  return {
    channel: r.slack_channel,
    thread_ts: r.slack_ts,
    reply_broadcast: true,
    text: `${icon} ${urgent ? `*${slackEscape(r.urgency, 20)}* enquiry from ${who}` : `Enquiry from ${who}`} has been waiting ${waitedText(r.waited_ms)} for approval: ${slackEscape(r.summary || "see the card", 200)}. Approve, edit or reject it above.`,
    unfurl_links: false,
  };
}
