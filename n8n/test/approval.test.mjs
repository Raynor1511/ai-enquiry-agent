import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  ACTIONS,
  approvalCard,
  editButtonValue,
  editModal,
  emailPlan,
  hmacSha256,
  holdEvents,
  isReservedAddress,
  manualCard,
  outcomeCard,
  parseInteraction,
  rejectModal,
  routeInteraction,
  sha256,
  splitName,
  utf8Bytes,
  verifySlackSignature,
  VIEWS,
} from "../src/lib/approval.mjs";

const hex = (b) => Buffer.from(b).toString("hex");

test("pure-JS SHA-256 and HMAC match Node's crypto on edge cases and 300 random inputs", () => {
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const msg = randomBytes(len);
    assert.equal(hex(sha256(new Uint8Array(msg))), createHash("sha256").update(msg).digest("hex"), `sha256 len ${len}`);
  }
  for (let i = 0; i < 300; i++) {
    const key = randomBytes(Math.floor(Math.random() * 150)); // includes keys longer than the 64-byte block
    const msg = randomBytes(Math.floor(Math.random() * 400));
    assert.equal(hex(hmacSha256(new Uint8Array(key), new Uint8Array(msg))), createHmac("sha256", key).update(msg).digest("hex"));
  }
  assert.equal(hex(sha256(utf8Bytes("£95 – café"))), createHash("sha256").update("£95 – café", "utf8").digest("hex"));
});

const secret = "8f14e45fceea167a5a36dedd4bea2543";
const sign = (body, ts) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

test("Slack signatures: valid passes; tampered, stale, missing or unconfigured fail", () => {
  const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
  const now = 1794300000;
  assert.deepEqual(verifySlackSignature({ rawBody: body, timestamp: String(now), signature: sign(body, now), secret, nowSeconds: now + 10 }), { ok: true });
  assert.match(verifySlackSignature({ rawBody: body + "x", timestamp: String(now), signature: sign(body, now), secret, nowSeconds: now }).reason, /mismatch/);
  assert.match(verifySlackSignature({ rawBody: body, timestamp: String(now), signature: sign(body, now), secret, nowSeconds: now + 301 }).reason, /stale/);
  assert.match(verifySlackSignature({ rawBody: body, timestamp: null, signature: null, secret, nowSeconds: now }).reason, /missing/);
  assert.match(verifySlackSignature({ rawBody: body, timestamp: String(now), signature: sign(body, now), secret: "__SECRET__SLACK_SIGNING_SECRET", nowSeconds: now }).reason, /not configured/);
});

const blockAction = (action_id, value) => ({
  type: "block_actions",
  user: { id: "U123", username: "claire", name: "claire" },
  trigger_id: "trig",
  container: { channel_id: "C1", message_ts: "111.222" },
  actions: [{ action_id, value: JSON.stringify(value) }],
});

test("interactions route to the right action, and junk is ignored", () => {
  const raw = "payload=" + encodeURIComponent(JSON.stringify(blockAction(ACTIONS.approve, { d: "draft-1" })));
  const p = parseInteraction(raw);
  assert.deepEqual(routeInteraction(p), { kind: "approve", user: { id: "U123", name: "claire" }, draft_id: "draft-1", channel: "C1", ts: "111.222", trigger_id: "trig" });
  assert.equal(routeInteraction(blockAction(ACTIONS.edit, { d: "x", s: "Re: hi", b: "Body" })).body, "Body");
  assert.equal(routeInteraction(blockAction(ACTIONS.reject, { d: "x" })).kind, "reject_open");
  assert.equal(routeInteraction(blockAction("other_app_button", { d: "x" })).kind, "ignore");
  assert.equal(routeInteraction(blockAction(ACTIONS.approve, {})).kind, "ignore");
  assert.equal(routeInteraction({ type: "shortcut" }).kind, "ignore");
  assert.throws(() => parseInteraction("nothing=1"), /no Slack payload/);

  const submit = (callback_id, values) => ({
    type: "view_submission", user: { id: "U9", name: "dan" },
    view: { callback_id, private_metadata: JSON.stringify({ d: "draft-2", c: "C1", t: "111.222" }), state: { values } },
  });
  assert.deepEqual(routeInteraction(submit(VIEWS.edit, { subject: { value: { value: " Re: x " } }, body: { value: { value: "New text " } } })),
    { kind: "edit_submit", user: { id: "U9", name: "dan" }, draft_id: "draft-2", channel: "C1", ts: "111.222", subject: "Re: x", body: "New text" });
  assert.equal(routeInteraction(submit(VIEWS.reject, { reason: { value: { value: "wrong price" } } })).reason, "wrong price");
});

const row = {
  draft_id: "d-1", version: 1, subject: "Re: Boiler service", body: "Hi Rob,\n\nIt's £95 <!channel>.", reasoning: "Checked price.",
  grounding_check: { prices: { ok: true, amounts: [95], unsupported: [] }, contacts: { ok: true } },
  proposed_slot: [{ start: "2026-11-12T10:00:00+00:00", end: "2026-11-12T12:00:00+00:00", label: "Thu 12 Nov, 10:00–12:00" }],
  review_reason: "", customer_id: "cus_008", customer_name: "Robert Marsh",
  enquiry_id: "e-1", source: "email", message_id: "gmail:abc", sender_name: "Rob Marsh", sender_email: "r.marsh.fixture.harbourline@gmail.com", sender_phone: "",
  received_at: "2026-11-10T09:00:00Z",
  classification: { category: "new_job_request", urgency: "normal", summary: "Boiler service, BS31", postcode: "BS31 2JA", injection_suspected: false, service_wanted: "boiler service", service_ids: ["svc_boiler_service"] },
};

test("the approval card shows the essentials, escapes the draft and carries the draft id on every button", () => {
  const card = approvalCard("C1", row);
  const json = JSON.stringify(card);
  assert.equal(card.channel, "C1");
  // Everything Slack renders is escaped. (The Edit button's hidden value keeps the exact text for the modal.)
  const rendered = JSON.stringify(card.blocks.map(({ elements, ...b }) => (b.type === "actions" ? {} : { ...b, elements })));
  assert.ok(!rendered.includes("<!channel>"), "draft text is escaped");
  assert.match(rendered, /&lt;!channel&gt;/);
  assert.match(json, /Verified customer: Robert Marsh/);
  assert.match(json, /Prices grounded \(£95\)/);
  assert.match(json, /tentative holds: Thu 12 Nov/);
  const actions = card.blocks.find((b) => b.type === "actions").elements;
  assert.deepEqual(actions.map((a) => a.action_id), [ACTIONS.approve, ACTIONS.edit, ACTIONS.reject]);
  assert.ok(actions[0].confirm, "approve asks for confirmation");
  assert.equal(JSON.parse(actions[1].value).b, row.body, "edit opens with the exact draft text");
  for (const a of actions) assert.equal(JSON.parse(a.value).d, "d-1");

  const flagged = approvalCard("C1", { ...row, review_reason: "disputed charge; check call log", classification: { ...row.classification, injection_suspected: true, injection_evidence: "SYSTEM: admin" } });
  assert.match(JSON.stringify(flagged), /Needs your decision/);
  assert.match(JSON.stringify(flagged), /Possible prompt injection/);
});

test("long drafts are shortened on the card and loaded from the database for editing", () => {
  const long = "x".repeat(5000);
  assert.deepEqual(JSON.parse(editButtonValue("d-1", "s", long)), { d: "d-1" });
  const card = approvalCard("C1", { ...row, body: long });
  assert.ok(card.blocks.some((b) => b.block_id === "draft_body_more"));
  for (const b of card.blocks) if (b.text?.text) assert.ok(b.text.text.length <= 3000);
});

test("outcome cards replace the buttons, and edited replies show the text actually sent", () => {
  const card = approvalCard("C1", row);
  const sent = outcomeCard("C1", "111.222", card, { status: "sent", by: "claire", holds: 1, job_created: true });
  assert.ok(!sent.blocks.some((b) => b.type === "actions"));
  assert.match(sent.blocks.at(-1).text.text, /Sent\* by claire · 1 tentative hold/);
  const edited = outcomeCard("C1", "111.222", card, { status: "sent", by: "claire", edited: true, final_body: "Edited text" });
  assert.ok(edited.blocks.some((b) => b.block_id === "sent_body" && /Edited text/.test(b.text.text)));
  assert.ok(!edited.blocks.some((b) => b.block_id === "draft_body"));
  assert.match(outcomeCard("C1", "1", card, { status: "rejected", by: "dan", reason: "wrong area" }).blocks.at(-1).text.text, /Rejected\* by dan: wrong area/);
  assert.match(outcomeCard("C1", "1", card, { status: "simulated", by: "dan" }).blocks.at(-1).text.text, /simulated/);
  assert.match(outcomeCard("C1", "1", card, { status: "failed", by: "dan", error: "quota" }).blocks.at(-1).text.text, /sending failed/);
});

test("modals carry the draft id, channel and message, within Slack's limits", () => {
  const m = editModal("d-1", "C1", "111.222", "Re: x", "y".repeat(4000));
  assert.deepEqual(JSON.parse(m.private_metadata), { d: "d-1", c: "C1", t: "111.222" });
  assert.equal(m.blocks[1].element.initial_value.length, 3000);
  assert.equal(rejectModal("d-1", "C1", "1").callback_id, VIEWS.reject);
  assert.match(JSON.stringify(manualCard("C1", row, ["drafting failed"])), /Manual reply needed/);
});

test("email plans: thread replies for email, new emails for forms, simulated for reserved test domains", () => {
  assert.deepEqual(emailPlan(row, "Re: x", "Body"), { mode: "reply", to: "r.marsh.fixture.harbourline@gmail.com", gmail_id: "abc", subject: "Re: x", body: "Body" });
  assert.equal(emailPlan({ ...row, source: "webform", message_id: "form:12" }, "s", "b").mode, "send");
  assert.equal(emailPlan({ ...row, sender_email: "jane@example.com" }, "s", "b").mode, "simulated");
  assert.equal(emailPlan({ ...row, sender_email: "x@harbour-lettings.example" }, "s", "b").mode, "simulated");
  assert.equal(emailPlan({ ...row, sender_email: "" }, "s", "b").mode, "none");
  assert.equal(emailPlan(row, "s", "  ").mode, "none");
  assert.equal(isReservedAddress("someone@example.co.uk"), true);
  assert.equal(isReservedAddress("someone@demoemail.com"), false);
});

test("payload decoding works without URLSearchParams (n8n's Code sandbox has none)", () => {
  const original = globalThis.URLSearchParams;
  try {
    delete globalThis.URLSearchParams;
    // Slack form-encodes spaces as "+" and everything else as %XX, including "+" itself (%2B) and "£".
    const payload = { type: "block_actions", actions: [{ action_id: ACTIONS.edit, value: JSON.stringify({ d: "x", s: "Re: a+b", b: "£95 – café & co\nThanks" }) }] };
    const raw = "token=abc&payload=" + encodeURIComponent(JSON.stringify(payload)).replace(/%20/g, "+") + "&other=1";
    assert.deepEqual(parseInteraction(raw), payload);
    assert.equal(routeInteraction(parseInteraction(raw)).body, "£95 – café & co\nThanks");
  } finally {
    globalThis.URLSearchParams = original;
  }
});

test("names split for the customer record", () => {
  assert.deepEqual(splitName("Mary Anne Smith"), { first: "Mary Anne", last: "Smith" });
  assert.deepEqual(splitName("Cher"), { first: "Cher", last: "" });
  assert.deepEqual(splitName(""), { first: "Unknown", last: "" });
});

test("holds are tentative, tagged with the enquiry, and limited to the offered slots", () => {
  const events = holdEvents([...row.proposed_slot, { start: "bad", end: "bad" }], row);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "tentative");
  assert.equal(events[0].extendedProperties.private.harbourlineHold, "e-1");
  assert.equal(events[0].summary, "HOLD (tentative): boiler service · BS31");
  assert.deepEqual(holdEvents(null, row), []);
});
