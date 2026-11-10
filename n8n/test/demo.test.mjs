import { test } from "node:test";
import assert from "node:assert/strict";
import { fromDemo, fromForm, FORM_FIELDS } from "../src/lib/normalise.mjs";
import { emailPlan, holdEvents, holdTitle, sourceLabel } from "../src/lib/approval.mjs";
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

test("holds on the (public) calendar never carry a name or text the sender wrote, from any source", () => {
  const typed = "call Dana on 07700 900111 <script>";
  const row = { enquiry_id: "e1", message_id: "demo:x", sender_name: "Dana Visitor", source: "demo",
    classification: { category: "new_job_request", service_wanted: typed, service_ids: ["svc_boiler_repair"], postcode: "BS6 6AL" } };
  const slot = { start: "2026-11-12T10:00:00Z", end: "2026-11-12T12:00:00Z" };
  for (const source of ["demo", "webform", "email"]) {
    const [ev] = holdEvents([slot], { ...row, source }, "Europe/London", Date.parse("2026-11-10T09:00:00Z"));
    assert.equal(ev.summary, "HOLD (tentative): boiler repair · BS6");
    assert.ok(!/Dana|07700|<script/.test(JSON.stringify(ev)), `nothing personal in a ${source} hold`);
  }
  assert.equal(holdTitle({ category: "quote_request", service_wanted: typed, postcode: "my house" }), "quote request · area unknown");
  assert.equal(holdTitle({ category: "emergency", service_ids: ["svc_burst_pipe"], postcode: "sw1a 1aa" }), "burst pipe · SW1A");
  assert.equal(holdTitle(null), "enquiry · area unknown");
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

test("demo requests are checked again inside n8n", async () => {
  const { checkStart, tokenHash, isTokenHash, confirmEmail, checkDecision, decideRoute, confirmOutcome } = await import("../src/lib/demo.mjs");
  const { createHash, randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  assert.equal(tokenHash(token), createHash("sha256").update(token).digest("hex"), "the pure-JS hash matches Node's");
  assert.ok(isTokenHash(tokenHash(token)));
  const good = { token, token_hash: tokenHash(token), email: " Dana@Visitor-Mail.org ", name: "Dana", payload: { message: "My boiler is banging loudly.", postcode: "BS6", service_needed: "Boiler or heating", phone: "" } };
  const r = checkStart(good);
  assert.ok(r.ok);
  assert.equal(r.session.email, "dana@visitor-mail.org");
  assert.deepEqual(Object.keys(r.session.payload).sort(), ["message", "postcode", "service_needed"], "empty phone dropped");
  assert.equal(checkStart({ ...good, token_hash: tokenHash("other") }).error, "bad token");
  assert.equal(checkStart({ ...good, email: "dana@example.com" }).error, "reserved email");
  assert.ok(checkStart({ ...good, email: "dana@example.com", allow_reserved: true }).ok);
  assert.equal(checkStart({ ...good, email: "not an email" }).error, "bad email");
  assert.equal(checkStart({ ...good, payload: { ...good.payload, message: "x".repeat(3001) } }).error, "message too long");
  assert.equal(checkStart({ ...good, payload: { ...good.payload, message: "hi" } }).error, "message too short");
  assert.equal(checkStart({ ...good, name: " " }).error, "name missing");

  const mail = confirmEmail("enquiries.example.org", token, "Dana Visitor");
  assert.equal(mail.link, `https://enquiries.example.org/demo/confirm?t=${token}`);
  assert.match(mail.body, /^Hi Dana,/);
  assert.match(mail.body, /fictional company/);
  assert.match(mail.body, /deleted automatically after 7 days/);

  const h = tokenHash(token);
  assert.equal(checkDecision({ token_hash: "x", kind: "approve" }).error, "bad token");
  assert.equal(checkDecision({ token_hash: h, kind: "delete" }).error, "bad decision");
  assert.equal(checkDecision({ token_hash: h, kind: "edit_submit", body: " " }).error, "edited reply is empty");
  const d = checkDecision({ token_hash: h, kind: "edit_submit", subject: "Re: boiler", body: "Hello\r\nDana" }).decision;
  assert.deepEqual(decideRoute(d, { draft_id: "d1", enquiry_status: "awaiting_approval" }).route,
    { kind: "edit_submit", draft_id: "d1", user: { id: "demo", name: "Demo visitor" }, subject: "Re: boiler", body: "Hello\nDana" });
  assert.deepEqual(decideRoute(d, { draft_id: "d1", enquiry_status: "sent" }), { ok: false, status: "sent" });
  assert.deepEqual(decideRoute(d, { draft_id: null, enquiry_status: null }), { ok: false, status: "unknown" });
  const rej = checkDecision({ token_hash: h, kind: "reject_submit" }).decision;
  assert.equal(decideRoute(rej, { draft_id: "d1", enquiry_status: "awaiting_approval" }).route.reason, "Rejected on the demo page");

  assert.equal(confirmOutcome({ id: "s1", prior_status: "pending" }, 30), "confirmed");
  assert.equal(confirmOutcome({ id: null, prior_status: "confirmed" }, 30), "already");
  assert.equal(confirmOutcome({ id: null, prior_status: null }, 30), "unknown");
  assert.equal(confirmOutcome({ id: null, prior_status: "pending", expired: true, runs_24h: 0 }, 30), "expired");
  assert.equal(confirmOutcome({ id: null, prior_status: "pending", expired: false, runs_24h: 30 }, 30), "busy");
});
