import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeState, STUCK_AFTER_MS } from "../lib/view.mjs";

const T0 = Date.parse("2026-11-11T10:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const session = { status: "confirmed", name: "Dana", confirmed_at: at(0), payload: { message: "Banging boiler", postcode: "BS6", service_needed: "Boiler or heating" } };

test("unknown links, unconfirmed and just-confirmed sessions", () => {
  assert.deepEqual(shapeState(null), { found: false });
  assert.equal(shapeState({ session: { ...session, status: "pending" } }).phase, "unconfirmed");
  const s = shapeState({ session }, { now: T0 + 1000 });
  assert.equal(s.phase, "starting");
  assert.equal(s.settled, false);
  assert.equal(s.stuck, false);
  assert.equal(shapeState({ session }, { now: T0 + STUCK_AFTER_MS + 1 }).stuck, true);
  assert.equal(s.session.message, "Banging boiler");
});

test("each enquiry status maps to a stage, and polling stops when only the visitor can act", () => {
  const cases = { received: ["classifying", false], classified: ["drafting", false], drafted: ["posting", false], awaiting_approval: ["awaiting_decision", true],
    sending: ["sending", false], sent: ["sent", true], rejected: ["rejected", true], needs_review: ["needs_person", true], archived: ["archived", true], failed: ["failed", true] };
  for (const [status, [phase, settled]] of Object.entries(cases)) {
    const s = shapeState({ session, enquiry: { status, received_at: at(0) }, timeline: [] }, { now: T0 });
    assert.equal(s.phase, phase, status);
    assert.equal(s.settled, settled, status);
  }
});

test("the timeline reads well, hides internal rows, and adds up the cost", () => {
  const s = shapeState({
    session,
    enquiry: { status: "sent", received_at: at(0), category: "new_job_request" },
    timeline: [
      { step: "intake", event: "received", at: at(0) },
      { step: "classify", event: "classified", at: at(2), model: "claude-haiku-5-5", cost_usd: 0.0012, duration_ms: 1800 },
      { step: "draft", event: "drafted", at: at(30), model: "claude-sonnet-5-5", cost_usd: "0.0345", duration_ms: 27000 },
      { step: "approval", event: "card_posted", at: at(31) },
      { step: "approval", event: "sent", at: at(90) },
      { step: "approval", event: "outcome", at: at(91) },
      { step: "something", event: "new_thing", at: at(92) },
    ],
  }, { calendarUrl: "https://calendar.google.com/calendar/embed?src=x", now: T0 + 100_000 });
  assert.deepEqual(s.steps.map((x) => x.label), [
    "Enquiry received and saved", "Classified (Claude Haiku)", "Reply drafted (Claude Sonnet, using the business's tools)",
    "Approval card posted in the team's Slack", "Approved, and the reply emailed", "something: new thing",
  ]);
  assert.equal(s.steps[2].after_ms, 30_000);
  assert.equal(s.totals.cost_usd, 0.0357);
  assert.equal(s.totals.elapsed_ms, 92_000);
  assert.equal(s.calendar_url, "https://calendar.google.com/calendar/embed?src=x");
  assert.equal(s.stuck, false, "settled pages are never stuck");
});
