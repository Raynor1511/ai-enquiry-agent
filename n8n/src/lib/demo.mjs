// The self-serve demo page (docs/demo.md): requests from the demo service, checked again here, and the
// confirmation email. Pure functions: inlined into n8n Code nodes by n8n/build.mjs (together with
// approval.mjs, for sha256 and isReservedAddress) and unit-tested in n8n/test/demo.test.mjs.
import { isReservedAddress, sha256, utf8Bytes } from "./approval.mjs";

/** Field limits, the same as the demo page's form (demo/lib/validate.mjs). */
export const DEMO_LIMITS = { name: 80, email: 254, postcode: 10, service: 60, message: 3000, phone: 30, subject: 200, body: 6000, reason: 500 };

const DEMO_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const DEMO_HASH = /^[0-9a-f]{64}$/;
const DEMO_EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const demoText = (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim() : "");
const demoHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const tokenHash = (token) => demoHex(sha256(utf8Bytes(token)));
export const isTokenHash = (v) => typeof v === "string" && DEMO_HASH.test(v);

/** A new submission: { token, token_hash, email, name, payload }. The hash must belong to the token. */
export function checkStart(body) {
  const b = body ?? {};
  const token = demoText(b.token);
  if (!DEMO_TOKEN.test(token) || tokenHash(token) !== b.token_hash) return { ok: false, error: "bad token" };
  const email = demoText(b.email).toLowerCase();
  if (!DEMO_EMAIL.test(email) || email.length > DEMO_LIMITS.email) return { ok: false, error: "bad email" };
  if (isReservedAddress(email) && !b.allow_reserved) return { ok: false, error: "reserved email" };
  const p = b.payload ?? {};
  const fields = { name: demoText(b.name), postcode: demoText(p.postcode), service_needed: demoText(p.service_needed), message: demoText(p.message), phone: demoText(p.phone) };
  const limit = { name: DEMO_LIMITS.name, postcode: DEMO_LIMITS.postcode, service_needed: DEMO_LIMITS.service, message: DEMO_LIMITS.message, phone: DEMO_LIMITS.phone };
  for (const [k, v] of Object.entries(fields)) if (v.length > limit[k]) return { ok: false, error: `${k} too long` };
  if (!fields.name) return { ok: false, error: "name missing" };
  if (fields.message.length < 10) return { ok: false, error: "message too short" };
  const { name, ...payload } = fields;
  if (!payload.phone) delete payload.phone;
  return { ok: true, session: { token, token_hash: b.token_hash, email, name, payload } };
}

/** The confirmation email. The link opens a page with a button, so link scanners can't start the demo. */
export function confirmEmail(publicHost, token, name) {
  // The token is in the fragment, which browsers never send to a server, so it stays out of every log.
  const link = `https://${publicHost}/demo/confirm#${token}`;
  const first = String(name ?? "").trim().split(/\s+/)[0] || "there";
  return {
    link,
    subject: "Confirm your Harbourline demo enquiry",
    body: [
      `Hi ${first},`,
      "",
      "Someone (hopefully you) sent an enquiry on the Harbourline live demo with this email address.",
      "Harbourline Plumbing & Heating is a fictional company: this is a demo of an AI enquiry agent.",
      "",
      "To start the demo and watch your enquiry being handled, open this link and press \"Start my demo\":",
      link,
      "",
      "The link works for 24 hours. If you approve the drafted reply on the demo page, it will be emailed",
      "to this address. Your enquiry and everything made from it is deleted automatically after 7 days.",
      "",
      "If you didn't ask for this, ignore this email: nothing happens unless the link is used.",
    ].join("\n"),
  };
}

/** A decision from the demo page: { token_hash, kind, subject?, body?, reason? }. */
export function checkDecision(body) {
  const b = body ?? {};
  if (!isTokenHash(b.token_hash)) return { ok: false, error: "bad token" };
  if (!["approve", "edit_submit", "reject_submit"].includes(b.kind)) return { ok: false, error: "bad decision" };
  const subject = demoText(b.subject), text = demoText(b.body), reason = demoText(b.reason);
  if (subject.length > DEMO_LIMITS.subject || text.length > DEMO_LIMITS.body || reason.length > DEMO_LIMITS.reason) return { ok: false, error: "too long" };
  if (b.kind === "edit_submit" && !text) return { ok: false, error: "edited reply is empty" };
  return { ok: true, decision: { token_hash: b.token_hash, kind: b.kind, subject, body: text, reason } };
}

/** The route the Decide reply workflow takes, for the session's latest draft. */
export function decideRoute(decision, found) {
  if (!found?.draft_id) return { ok: false, status: found?.enquiry_status ? `no draft (${found.enquiry_status})` : "unknown" };
  if (found.enquiry_status !== "awaiting_approval") return { ok: false, status: found.enquiry_status };
  const route = { kind: decision.kind, draft_id: found.draft_id, user: { id: "demo", name: "Demo visitor" } };
  if (decision.kind === "edit_submit") Object.assign(route, { subject: decision.subject || null, body: decision.body });
  if (decision.kind === "reject_submit") route.reason = decision.reason || "Rejected on the demo page";
  return { ok: true, route };
}

/** What a confirm attempt came to, from the confirm query's single row. */
export function confirmOutcome(row, runsCap) {
  if (row?.id) return "confirmed";
  if (row?.prior_status === "confirmed") return "already";
  if (!row?.prior_status) return "unknown";
  if (row.expired) return "expired";
  if (Number(row.runs_24h) >= runsCap) return "busy";
  return "already"; // still pending when read, but a simultaneous click confirmed it first
}
