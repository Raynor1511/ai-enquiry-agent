import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkDecision, checkSubmission, hashToken, isReservedAddress, newToken } from "../lib/validate.mjs";

const good = { name: " Dana Visitor ", email: " Dana@Visitor-Mail.org ", postcode: "bs6 6al", service_needed: "Boiler or heating", message: "My boiler is banging.\r\nCan someone look?" };

test("a good submission is cleaned up into what n8n expects", () => {
  const r = checkSubmission(good);
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    name: "Dana Visitor", email: "dana@visitor-mail.org",
    payload: { postcode: "BS6 6AL", service_needed: "Boiler or heating", message: "My boiler is banging.\nCan someone look?" },
  });
  assert.equal(checkSubmission({ ...good, service_needed: "" }).value.payload.service_needed, "Something else");
  assert.equal(checkSubmission({ ...good, phone: "07700 900111" }).value.payload.phone, "07700 900111");
});

test("bad submissions get a message per field", () => {
  const r = checkSubmission({ name: "", email: "nope", message: "hi", service_needed: "Rocket repair", postcode: "X".repeat(11) });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["email", "message", "name", "postcode", "service_needed"]);
  assert.match(checkSubmission({ ...good, email: "a@example.com" }).errors.email, /can't receive email/);
  assert.match(checkSubmission({ ...good, email: "a@mail.example.org" }).errors.email, /can't receive email/);
  assert.match(checkSubmission({ ...good, message: "x".repeat(3001) }).errors.message, /At most 3000/);
  assert.equal(checkSubmission(null).ok, false);
  assert.equal(checkSubmission("text").ok, false);
});

test("the hidden honeypot field marks a bot", () => {
  const r = checkSubmission({ ...good, website: "http://spam.example" });
  assert.equal(r.ok, false);
  assert.equal(r.bot, true);
});

test("links are 32 random bytes; only their SHA-256 is kept, and only our format is accepted", () => {
  const a = newToken();
  const b = newToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.equal(a.token_hash, createHash("sha256").update(a.token).digest("hex"));
  assert.equal(hashToken(a.token), a.token_hash);
  for (const bad of ["", "short", `${a.token}x`, "../../etc/passwd" + "a".repeat(30), null, 42, { t: 1 }]) assert.equal(hashToken(bad), null);
});

test("decisions: approve, edit (non-empty), reject with an optional reason", () => {
  assert.deepEqual(checkDecision({ kind: "approve", body: "ignored" }).value, { kind: "approve" });
  assert.deepEqual(checkDecision({ kind: "edit_submit", subject: " Re: x ", body: "Hi\r\nthere" }).value, { kind: "edit_submit", subject: "Re: x", body: "Hi\nthere" });
  assert.equal(checkDecision({ kind: "edit_submit", body: "  " }).ok, false);
  assert.deepEqual(checkDecision({ kind: "reject_submit", reason: "no" }).value, { kind: "reject_submit", reason: "no" });
  assert.equal(checkDecision({ kind: "delete" }).ok, false);
  assert.equal(checkDecision({ kind: "edit_submit", body: "x".repeat(6001) }).ok, false);
});

test("reserved addresses match n8n's rule", () => {
  for (const e of ["a@example.com", "a@x.example.org", "a@foo.test", "a@invalid", "nope"]) assert.ok(isReservedAddress(e), e);
  for (const e of ["a@gmail.com", "a@examples.com", "a@notexample.org"]) assert.ok(!isReservedAddress(e), e);
});
