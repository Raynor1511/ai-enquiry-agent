import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTIONS, HOLD_DAYS, holdEvents, routeInteraction } from "../src/lib/approval.mjs";
import { fromGmail } from "../src/lib/normalise.mjs";
import {
  BUSINESS_WORDS,
  RESCUE_ACTION,
  dueReminders,
  expiredHolds,
  groupByEnquiry,
  holdsReleasedReply,
  reminderMessage,
  rescueReply,
  spamAlert,
  spamCandidates,
  sweepStart,
  waitedText,
} from "../src/lib/housekeeping.mjs";

const H = 3600_000;
const D = 24 * H;
const NOW = Date.parse("2026-11-10T09:00:00Z");
const EID = "8b0f1d2e-3c4a-4b5d-8e6f-7a8b9c0d1e2f";
const row = { enquiry_id: EID, message_id: "form:1", sender_name: "Rob Marsh", classification: { category: "new_job_request", service_wanted: "boiler service", postcode: "BS31 1AA" } };
const slot = { start: "2026-11-12T10:00:00Z", end: "2026-11-12T12:00:00Z" };
// What events.list returns for a hold created by holdEvents at `createdMs`.
const asListed = (ev, id, createdMs) => ({ ...ev, id, created: new Date(createdMs).toISOString() });

test("a new hold records when it will be released, and says how to keep it", () => {
  const [ev] = holdEvents([slot], row, "Europe/London", NOW);
  assert.equal(ev.extendedProperties.private.harbourlineHold, EID);
  assert.equal(ev.extendedProperties.private.harbourlineHoldExpires, new Date(NOW + HOLD_DAYS * D).toISOString());
  assert.match(ev.description, /Released automatically on Fri 13 Nov.*To keep it, take "HOLD" out of the title/s);
});

test("holds are released after their expiry, and only while they still look like holds", () => {
  const [ev] = holdEvents([slot], row, "Europe/London", NOW);
  const hold = asListed(ev, "h1", NOW);
  assert.deepEqual(expiredHolds([hold], NOW + HOLD_DAYS * D - 1), [], "not yet");
  const [x] = expiredHolds([hold], NOW + HOLD_DAYS * D);
  assert.deepEqual({ id: x.event_id, enquiry: x.enquiry_id, start: x.start }, { id: "h1", enquiry: EID, start: slot.start });
  const later = NOW + 10 * D;
  assert.deepEqual(expiredHolds([{ ...hold, summary: "Boiler service · Rob Marsh (confirmed)" }], later), [], "renamed = kept");
  assert.deepEqual(expiredHolds([{ ...hold, status: "confirmed" }], later), [], "confirmed = kept");
  const seed = { id: "s1", summary: "HOLD-looking demo booking", status: "tentative", created: new Date(NOW - 30 * D).toISOString(), extendedProperties: { private: { harbourlineSeed: "1" } } };
  assert.deepEqual(expiredHolds([seed], later), [], "demo bookings are never touched");
  // Holds made before expiry dates were stored: 3 days after creation.
  const legacy = { ...hold, extendedProperties: { private: { harbourlineHold: EID } } };
  assert.equal(expiredHolds([legacy], NOW + 3 * D - 1).length, 0);
  assert.equal(expiredHolds([legacy], NOW + 3 * D).length, 1);
  // A tag that isn't an enquiry id is still released, but not linked to an enquiry.
  assert.equal(expiredHolds([{ ...hold, extendedProperties: { private: { harbourlineHold: "x'; drop" } } }], NOW + 5 * D)[0].enquiry_id, "");
});

test("released holds are grouped per enquiry and reported in the card's thread", () => {
  const groups = groupByEnquiry([
    { event_id: "a", enquiry_id: EID, start: slot.start, end: slot.end },
    { event_id: "b", enquiry_id: EID, start: "2026-11-13T08:00:00Z", end: "2026-11-13T10:00:00Z" },
    { event_id: "c", enquiry_id: "", start: slot.start, end: slot.end },
  ]);
  assert.deepEqual(groups.map((g) => g.holds.length), [2, 1]);
  const msg = holdsReleasedReply("C1", "1.2", groups[0].holds);
  assert.equal(msg.thread_ts, "1.2");
  assert.match(msg.text, /Released 2 tentative hold\(s\).*Thu 12 Nov, 10:00–12:00; Fri 13 Nov, 08:00–10:00/);
});

test("the spam sweep starts after the last one, at most a week back", () => {
  assert.equal(sweepStart(undefined, NOW), new Date(NOW - D).toISOString());
  assert.equal(sweepStart(NOW - 5 * H, NOW), new Date(NOW - 5 * H).toISOString());
  assert.equal(sweepStart(NOW - 30 * D, NOW), new Date(NOW - 7 * D).toISOString());
  assert.equal(sweepStart(NOW + H, NOW), new Date(NOW - D).toISOString(), "clock skew");
});

test("only spam that mentions what we do is listed, best matches first", () => {
  const mail = (id, subject, text, from = "a@example.com") => fromGmail({ id, subject, text, from: { value: [{ address: from, name: "A" }] }, date: "2026-11-10T08:00:00Z" });
  const found = spamCandidates([
    mail("18c1", "WIN A PRIZE", "Claim your Vegas casino bonus now"),
    mail("18c2", "Leaking pipe", "Hi, my boiler is leaking from a pipe under the sink, can you quote?"),
    mail("18c3", "Question", "Do you fit showers?"),
    mail("18c4", "Tapestry sale", "Beautiful tapestries"),
  ]);
  assert.deepEqual(found.map((f) => f.gmail_id), ["18c2"], "word boundaries: 'Vegas' isn't gas, 'Tapestry' isn't tap, 'showers' isn't 'shower'");
  assert.deepEqual(found[0].matched.sort(), ["boiler", "leaking", "pipe", "quote"]);
  assert.ok(BUSINESS_WORDS.includes("boiler"));
  assert.equal(spamCandidates([mail("18d1", "boiler", "boiler")], ["Boiler", "boiler "]).length, 1);
});

test("the spam alert escapes everything and gives each email a Process button", () => {
  const [c] = spamCandidates([fromGmail({ id: "18c2", subject: "<!channel> boiler", text: "boiler <https://evil.example|x>", from: { value: [{ address: "a@example.com", name: "A" }] } })]);
  const msg = spamAlert("CALERT", [c], 3);
  const json = JSON.stringify(msg);
  assert.ok(!json.includes("<!channel>") && !json.includes("<https://"));
  const button = msg.blocks[2].accessory;
  assert.equal(button.action_id, RESCUE_ACTION);
  assert.equal(button.action_id, ACTIONS.rescue, "the router knows the button");
  assert.deepEqual(JSON.parse(button.value), { g: "18c2" });
  assert.match(json, /Checked 3 new message\(s\) in Spam; 2 looked like ordinary spam/);
});

test("pressing Process routes to a rescue with a validated Gmail id", () => {
  const press = (value) => routeInteraction({ type: "block_actions", user: { id: "U1", name: "sam" }, container: { channel_id: "CALERT", message_ts: "9.9" }, actions: [{ action_id: ACTIONS.rescue, value: JSON.stringify(value) }] });
  assert.deepEqual(press({ g: "18c2ab34ef" }), { kind: "rescue", user: { id: "U1", name: "sam" }, gmail_id: "18c2ab34ef", channel: "CALERT", ts: "9.9" });
  assert.equal(press({ g: "../../etc" }).kind, "ignore");
  assert.equal(press({}).kind, "ignore");
});

test("the rescue reply says what happened", () => {
  const user = { name: "sam" };
  assert.match(rescueReply("C", "1", user, { status: "classified" }, { status: "awaiting_approval" }).text, /approval card .* #enquiries\. The email was moved to the inbox/);
  assert.match(rescueReply("C", "1", user, { status: "duplicate" }, { status: "not_posted" }).text, /already been processed/);
  assert.match(rescueReply("C", "1", user, { status: "archived" }, { status: "not_posted" }, false).text, /agrees it is spam.*Couldn't move the email/);
  assert.equal(rescueReply("C", "1", user, {}, {}).thread_ts, "1");
});

test("reminders depend on urgency and repeat at a slower pace", () => {
  const card = (urgency, postedAgoMs, lastAgoMs) => ({
    enquiry_id: EID, urgency, sender_name: "Ann", summary: "Leak", slack_channel: "C1", slack_ts: "1.1",
    card_posted_at: new Date(NOW - postedAgoMs).toISOString(), last_reminder_at: lastAgoMs === undefined ? null : new Date(NOW - lastAgoMs).toISOString(),
  });
  const due = (rows) => dueReminders(rows, NOW).map((r) => r.urgency);
  assert.deepEqual(due([card("emergency", 29 * 60_000), card("normal", 3 * H)]), [], "too early");
  assert.deepEqual(due([card("emergency", 31 * 60_000), card("normal", 4 * H), card("low", 23 * H)]), ["emergency", "normal"]);
  assert.deepEqual(due([card("normal", 30 * H, 2 * H)]), [], "reminded recently");
  assert.deepEqual(due([card("normal", 30 * H, 25 * H)]), ["normal"], "a day later, again");
  assert.deepEqual(due([card("weird", 5 * H)]), ["weird"], "unknown urgency counts as normal");
  assert.deepEqual(due([{ ...card("normal", 5 * H), slack_ts: null }]), [], "no card to reply to");
  const msg = reminderMessage(dueReminders([card("emergency", 45 * 60_000)], NOW)[0]);
  assert.equal(msg.thread_ts, "1.1");
  assert.equal(msg.reply_broadcast, true);
  assert.match(msg.text, /🚨 \*emergency\* enquiry from Ann has been waiting 45 min for approval: Leak/);
  assert.equal(waitedText(5 * H), "5 h");
  assert.equal(waitedText(3 * D), "3 days");
});
