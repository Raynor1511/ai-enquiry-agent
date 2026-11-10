// Checks what visitors send to the demo page. n8n checks everything again (n8n/src/lib/demo.mjs):
// this layer exists to give visitors clear messages and to keep junk away from n8n.
import { createHash, randomBytes } from "node:crypto";

/** Field limits, the same as n8n's (n8n/src/lib/demo.mjs). */
export const LIMITS = { name: 80, email: 254, postcode: 10, service: 60, message: 3000, phone: 30, subject: 200, body: 6000, reason: 500 };

/** The same choices as the web form (n8n/build.mjs, Intake). */
export const SERVICE_OPTIONS = [
  "Boiler or heating", "Leak, pipe or blockage", "Bathroom or shower",
  "Gas appliance or safety certificate", "Something urgent", "Something else",
];

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const text = (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");

/** A new private link: 32 random bytes. Only its SHA-256 is stored. */
export function newToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, token_hash: hashToken(token) };
}

/** The stored form of a link's token, or null if it isn't one of ours. */
export function hashToken(token) {
  return typeof token === "string" && TOKEN.test(token) ? createHash("sha256").update(token).digest("hex") : null;
}

/** Domains that can never receive mail (the same rule as n8n/src/lib/approval.mjs). */
export function isReservedAddress(email) {
  const domain = String(email ?? "").toLowerCase().split("@")[1] ?? "";
  return !domain || /(^|\.)(example|test|invalid|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org|co\.uk)$/.test(domain);
}

/**
 * The landing page's form. Returns { ok, value } or { ok: false, errors: { field: message } }.
 * `website` is a hidden field people never fill in; bots that fill every field are refused quietly.
 */
export function checkSubmission(body) {
  const b = body && typeof body === "object" ? body : {};
  const v = {
    name: text(b.name), email: text(b.email).toLowerCase(), postcode: text(b.postcode).toUpperCase(),
    service_needed: text(b.service_needed), message: text(b.message), phone: text(b.phone),
  };
  const errors = {};
  if (text(b.website)) return { ok: false, bot: true, errors: { form: "Something went wrong. Please try again." } };
  if (!v.name) errors.name = "Please give a name (any name is fine).";
  else if (v.name.length > LIMITS.name) errors.name = `At most ${LIMITS.name} characters.`;
  if (!EMAIL.test(v.email) || v.email.length > LIMITS.email) errors.email = "Please enter a valid email address.";
  else if (isReservedAddress(v.email)) errors.email = "That address can't receive email. Use one you can open: the confirm link is sent there.";
  if (v.postcode.length > LIMITS.postcode) errors.postcode = `At most ${LIMITS.postcode} characters.`;
  if (v.service_needed && !SERVICE_OPTIONS.includes(v.service_needed)) errors.service_needed = "Please pick one of the options.";
  if (v.message.length < 10) errors.message = "Please write a little more (at least 10 characters).";
  else if (v.message.length > LIMITS.message) errors.message = `At most ${LIMITS.message} characters.`;
  if (v.phone.length > LIMITS.phone) errors.phone = `At most ${LIMITS.phone} characters.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  const payload = { postcode: v.postcode, service_needed: v.service_needed || "Something else", message: v.message };
  if (v.phone) payload.phone = v.phone;
  return { ok: true, value: { name: v.name, email: v.email, payload } };
}

/** A decision on the live page: approve as drafted, send an edited version, or reject. */
export function checkDecision(body) {
  const b = body && typeof body === "object" ? body : {};
  const kind = b.kind;
  if (!["approve", "edit_submit", "reject_submit"].includes(kind)) return { ok: false, error: "Unknown decision." };
  const subject = text(b.subject), reply = text(b.body), reason = text(b.reason);
  if (subject.length > LIMITS.subject) return { ok: false, error: `The subject can be at most ${LIMITS.subject} characters.` };
  if (reply.length > LIMITS.body) return { ok: false, error: `The reply can be at most ${LIMITS.body} characters.` };
  if (reason.length > LIMITS.reason) return { ok: false, error: `The reason can be at most ${LIMITS.reason} characters.` };
  if (kind === "edit_submit" && !reply) return { ok: false, error: "The edited reply is empty." };
  const value = { kind };
  if (kind === "edit_submit") Object.assign(value, { subject, body: reply });
  if (kind === "reject_submit") value.reason = reason;
  return { ok: true, value };
}
