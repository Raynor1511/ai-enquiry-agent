import { test } from "node:test";
import assert from "node:assert/strict";
import { fromForm, fromGmail, fromTestWebhook, htmlToText, parseAddress, FORM_FIELDS, MAX_BODY_CHARS } from "../src/lib/normalise.mjs";

test("web form submissions become a webform enquiry keyed by execution id", () => {
  const e = fromForm(
    {
      [FORM_FIELDS.name]: " Jane Doe ",
      [FORM_FIELDS.email]: "Jane@Example.com",
      [FORM_FIELDS.phone]: "",
      [FORM_FIELDS.postcode]: "bs6 6al",
      [FORM_FIELDS.service]: "Boiler service",
      [FORM_FIELDS.message]: "Hi,\r\nplease service my boiler.  \r\n",
      submittedAt: "2026-11-10T09:00:00.000+00:00",
    },
    "1234",
  );
  assert.deepEqual(e, {
    source: "webform",
    message_id: "form:1234",
    sender_name: "Jane Doe",
    sender_email: "jane@example.com",
    sender_phone: "",
    subject: "",
    body: "Hi,\nplease service my boiler.",
    body_truncated: false,
    form_fields: { postcode: "bs6 6al", service_needed: "Boiler service" },
    received_at: "2026-11-10T09:00:00.000Z",
    is_test: false,
    gmail_id: null,
  });
});

test("Gmail messages (full format) use the parsed From address and text body", () => {
  const e = fromGmail({
    id: "18c2f",
    from: { value: [{ address: "Rob.Marsh@example.com", name: "Rob Marsh" }], text: "Rob Marsh <rob.marsh@example.com>" },
    subject: "Boiler service",
    text: "Can I book my annual service?",
    date: "2026-11-10T08:15:00.000Z",
  });
  assert.equal(e.source, "email");
  assert.equal(e.message_id, "gmail:18c2f");
  assert.equal(e.gmail_id, "18c2f");
  assert.equal(e.sender_email, "rob.marsh@example.com");
  assert.equal(e.sender_name, "Rob Marsh");
  assert.equal(e.body, "Can I book my annual service?");
  assert.equal(e.form_fields, null);
});

test("Gmail messages (simplified format) fall back to the From header and HTML", () => {
  const e = fromGmail({ id: "x1", From: '"Ann Lee" <ann@example.net>', Subject: "Leak", html: "<p>Water&nbsp;under&amp;sink</p><br>Thanks", internalDate: "1789030800000" });
  assert.equal(e.sender_name, "Ann Lee");
  assert.equal(e.sender_email, "ann@example.net");
  assert.equal(e.subject, "Leak");
  assert.equal(e.body, "Water under&sink\n\nThanks");
  assert.equal(e.received_at, new Date(1789030800000).toISOString());
});

test("test webhook enquiries get a run-scoped message id and the test flag", () => {
  const e = fromTestWebhook({
    id: "enq_001",
    run_id: "r1",
    source: "email",
    sender: { name: "A", email: "a@example.com", phone: null },
    subject: "Hi",
    body: "Hello",
    received_at: "2026-11-12T19:42:00Z",
    form_fields: null,
  });
  assert.equal(e.message_id, "test:r1:enq_001");
  assert.equal(e.is_test, true);
  assert.equal(e.sender_phone, "");
  assert.throws(() => fromTestWebhook({ id: "x", source: "email" }), /run_id/);
  assert.throws(() => fromTestWebhook({ id: "x", run_id: "r", source: "sms" }), /source/);
});

test("very long bodies are cut and flagged, not silently dropped", () => {
  const e = fromTestWebhook({ id: "x", run_id: "r", source: "webform", body: "a".repeat(MAX_BODY_CHARS + 5) });
  assert.equal(e.body.length, MAX_BODY_CHARS);
  assert.equal(e.body_truncated, true);
});

test("empty form fields collapse to null and bad dates fall back to now", () => {
  const e = fromTestWebhook({ id: "x", run_id: "r", source: "webform", body: "hi", form_fields: { postcode: "", service_needed: " " }, received_at: "not a date" });
  assert.equal(e.form_fields, null);
  assert.ok(Math.abs(Date.parse(e.received_at) - Date.now()) < 5000);
});

test("address and HTML helpers", () => {
  assert.deepEqual(parseAddress("bob@example.com"), { name: "", email: "bob@example.com" });
  assert.deepEqual(parseAddress("Bob <BOB@example.com>"), { name: "Bob", email: "bob@example.com" });
  assert.equal(htmlToText("<style>x{}</style><div>a</div><div>b</div>"), "a\nb");
});
