#!/usr/bin/env node
// Validates eval/test-set/enquiries.json against the seed data, so labels stay consistent
// whenever enquiries or seed data are edited. Run: node scripts/validate-test-set.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(path.join(root, p), "utf8"));

const enquiries = read("eval/test-set/enquiries.json");
const customers = read("seed/data/customers.json");
const services = read("seed/data/services.json");
const areas = read("seed/data/service-areas.json");

const CATEGORIES = ["new_job_request", "quote_request", "emergency", "complaint", "existing_customer_followup", "spam"];
const URGENCIES = ["emergency", "high", "normal", "low"];
const EXPECTED_COUNTS = { new_job_request: 8, quote_request: 8, emergency: 7, complaint: 5, existing_customer_followup: 6, spam: 6 };
const RESERVED_EMAIL = /@([a-z0-9-]+\.)*(example(\.com|\.net|\.org|\.co\.uk)?|[a-z0-9-]+\.example)$/i;
const DRAMA_PHONE = /^(07700900\d{3}|01174960\d{3})$/;

const phone = (p) => {
  if (!p) return null;
  let d = p.replace(/\(0\)/g, "").replace(/\D/g, "");
  if (d.startsWith("0044")) d = "0" + d.slice(4);
  else if (d.startsWith("44") && d.length === 12) d = "0" + d.slice(2);
  return d;
};
const outward = (pc) => {
  const m = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})?$/.exec((pc ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
  return m ? m[1] : null;
};
const zoneOf = new Map(areas.zones.flatMap((z) => Object.keys(z.districts).map((d) => [d, z.zone])));
const customerById = new Map(customers.map((c) => [c.id, c]));
const serviceIds = new Set(services.map((s) => s.id));

const errors = [];
const fail = (id, msg) => errors.push(`${id}: ${msg}`);

if (!Array.isArray(enquiries)) throw new Error("enquiries.json must be an array");
if (enquiries.length !== 40) errors.push(`expected 40 enquiries, found ${enquiries.length}`);

const seenIds = new Set();
const seenMessageIds = new Set();
const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
let injections = 0;

for (const e of enquiries) {
  const id = e.id ?? "(no id)";
  const l = e.labels ?? {};
  if (seenIds.has(id)) fail(id, "duplicate id");
  seenIds.add(id);
  if (e.message_id) {
    if (seenMessageIds.has(e.message_id)) fail(id, "duplicate message_id");
    seenMessageIds.add(e.message_id);
  }
  if (!["email", "webform"].includes(e.source)) fail(id, `bad source ${e.source}`);
  if (e.source === "email" && !e.message_id) fail(id, "email without message_id");
  if (e.source === "webform" && !e.form_fields) fail(id, "webform without form_fields");
  if (Number.isNaN(Date.parse(e.received_at))) fail(id, "bad received_at");
  if (!e.body?.trim()) fail(id, "empty body");

  if (!CATEGORIES.includes(l.category)) fail(id, `bad category ${l.category}`);
  else counts[l.category]++;
  if (!URGENCIES.includes(l.urgency)) fail(id, `bad urgency ${l.urgency}`);
  if ((l.category === "emergency") !== (l.urgency === "emergency")) fail(id, "emergency category and urgency must agree");
  if (l.is_injection) injections++;
  if (l.is_injection && !l.tags?.includes("injection")) fail(id, "injection without tag");
  if (l.category === "spam" && l.should_reply !== false) fail(id, "spam must have should_reply false");
  if (l.category !== "spam" && l.should_reply !== true) fail(id, "non-spam must have should_reply true");
  if (l.category !== "spam" && !(l.required_facts?.length > 0)) fail(id, "needs required_facts");
  if (l.category !== "spam" && !(l.forbidden_facts?.length > 0)) fail(id, "needs forbidden_facts");

  for (const s of l.expected_service_ids ?? []) if (!serviceIds.has(s)) fail(id, `unknown service ${s}`);

  // Senders must be fictional.
  if (e.sender?.email && !RESERVED_EMAIL.test(e.sender.email)) fail(id, `non-reserved email ${e.sender.email}`);
  if (e.sender?.phone && !DRAMA_PHONE.test(phone(e.sender.phone))) fail(id, `non-drama phone ${e.sender.phone}`);

  // A customer id is only expected when the sender's email or phone really matches that customer.
  const matching = customers.filter(
    (c) =>
      (e.sender?.email && c.email.toLowerCase() === e.sender.email.toLowerCase()) ||
      (e.sender?.phone && phone(c.phone) === phone(e.sender.phone)),
  );
  if (l.expected_customer_id) {
    if (!customerById.has(l.expected_customer_id)) fail(id, `unknown customer ${l.expected_customer_id}`);
    else if (!matching.some((c) => c.id === l.expected_customer_id)) fail(id, "expected customer does not match sender email/phone");
  } else if (matching.length) {
    fail(id, `sender matches ${matching.map((c) => c.id).join(",")} but expected_customer_id is null`);
  }

  if (l.postcode) {
    const out = outward(l.postcode);
    if (!out) fail(id, `invalid postcode ${l.postcode}`);
    else if (Boolean(zoneOf.get(out)) !== l.in_service_area) fail(id, `in_service_area ${l.in_service_area} disagrees with ${out}`);
  } else if (l.in_service_area !== null) {
    fail(id, "in_service_area must be null when postcode is unknown");
  }
}

for (const [c, n] of Object.entries(EXPECTED_COUNTS)) if (counts[c] !== n) errors.push(`expected ${n} ${c}, found ${counts[c]}`);
if (injections !== 3) errors.push(`expected 3 injection attempts, found ${injections}`);

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s):\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`✓ ${enquiries.length} enquiries valid`, counts, `injections: ${injections}`);
