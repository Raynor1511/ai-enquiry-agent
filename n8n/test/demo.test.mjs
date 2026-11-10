import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDemo, fromForm, FORM_FIELDS } from "../src/lib/normalise.mjs";
import { emailPlan, holdEvents, sourceLabel } from "../src/lib/approval.mjs";
import { emergencyAlert } from "../src/lib/slack.mjs";

const session = {
  id: "5b1f9a2e-7c3d-4e8f-9a0b-1c2d3e4f5a6b",
  email: "  Visitor@Example.com ",
  name: "Dana Visitor",
  payload: { postcode: " BS6 6AL ", service_needed: "Boiler or heating", message: "My boiler is making a banging noise.\r\nCan someone look?", phone: "07700 900111" },
  confirmed_at: "2026-11-11T10:00:00Z",
};

test("a confirmed demo submission becomes the same record shape as a web-form enquiry", () => {
  const d = fromDemo(session);
  assert.equal(d.source, "demo");
  assert.equal(d.message_id, `demo:${session.id}`);
  assert.equal(d.sender_email, "visitor@example.com");
  assert.equal(d.body, "My boiler is making a banging noise.\nCan someone look?");
  assert.deepEqual(d.form_fields, { postcode: "BS6 6AL", service_needed: "Boiler or heating" });
  assert.equal(d.received_at, "2026-11-11T10:00:00.000Z");
  assert.equal(d.is_test, false);
  const form = fromForm({ [FORM_FIELDS.name]: "x", [FORM_FIELDS.email]: "x@example.com", [FORM_FIELDS.message]: "m", [FORM_FIELDS.postcode]: "BS6", [FORM_FIELDS.service]: "s", submittedAt: "2026-11-11T10:00:00Z" }, 1);
  assert.deepEqual(Object.keys(d).sort(), Object.keys(form).sort(), "same fields as the web form");
  assert.throws(() => fromDemo({ ...session, email: " " }), /confirmed email/);
  assert.throws(() => fromDemo({ ...session, id: null }), /id/);
});

test("demo holds never carry the visitor's name; other holds still do", () => {
  const row = { enquiry_id: "e1", message_id: "demo:x", sender_name: "Dana Visitor", source: "demo", classification: { category: "new_job_request", service_wanted: "boiler repair", postcode: "BS6 6AL" } };
  const slot = { start: "2026-11-12T10:00:00Z", end: "2026-11-12T12:00:00Z" };
  const [demo] = holdEvents([slot], row, "Europe/London", Date.parse("2026-11-10T09:00:00Z"));
  assert.match(demo.summary, /demo visitor \(BS6\)/);
  assert.ok(!JSON.stringify(demo).includes("Dana"), "no name anywhere in the event");
  const [form] = holdEvents([slot], { ...row, source: "webform" }, "Europe/London", Date.parse("2026-11-10T09:00:00Z"));
  assert.match(form.summary, /Dana Visitor \(BS6\)/);
});

test("an approved demo reply is a new email to the confirmed address (never a thread reply)", () => {
  const row = { source: "demo", message_id: "demo:x", sender_email: "dana@visitor-mail.example.org" };
  assert.equal(emailPlan({ ...row, sender_email: "d.visitor.fixture.harbourline@gmail.com" }, "Re: boiler", "Hello").mode, "send");
  assert.equal(emailPlan(row, "Re: boiler", "Hello").mode, "simulated", "reserved domains stay simulated");
});

test("people reading cards and alerts see where a demo enquiry came from", () => {
  assert.equal(sourceLabel("demo"), "the live demo");
  assert.equal(sourceLabel("email"), "email");
  assert.equal(sourceLabel("webform"), "web form");
  const alert = emergencyAlert("C1", { source: "demo", sender_name: "Dana", received_at: "2026-11-11T10:00:00Z", body: "Gas smell" }, { summary: "Gas smell", urgency_reason: "gas", safety_flags: [] });
  assert.match(JSON.stringify(alert), /by the live demo/);
});
