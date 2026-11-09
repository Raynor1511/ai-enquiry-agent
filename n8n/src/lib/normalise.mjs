// Turns each enquiry source (web form, Gmail, test webhook) into one record shape.
// Pure functions: inlined into n8n Code nodes by n8n/build.mjs and unit-tested in n8n/test.

export const MAX_BODY_CHARS = 20000;

/** Labels of the web form's fields, which are also the keys n8n's Form Trigger outputs. */
export const FORM_FIELDS = {
  name: "Your name",
  email: "Email",
  phone: "Phone (optional)",
  postcode: "Postcode",
  service: "What do you need help with?",
  message: "Message",
};

const clean = (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").trim() : v == null ? "" : String(v).trim());

function isoOrNow(value) {
  const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value ?? ""));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Very small HTML-to-text fallback for HTML-only emails. */
export function htmlToText(html) {
  return clean(
    String(html ?? "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n"),
  );
}

/** "Jane Doe <jane@example.com>" -> { name, email } */
export function parseAddress(text) {
  const s = clean(text);
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: clean(m[1].replace(/^"|"$/g, "")), email: clean(m[2]).toLowerCase() };
  return /@/.test(s) ? { name: "", email: s.toLowerCase() } : { name: s, email: "" };
}

/** Final shape shared by every source. Long bodies are cut, and flagged, rather than silently dropped. */
export function finalise(e) {
  let body = clean(e.body);
  const truncated = body.length > MAX_BODY_CHARS;
  if (truncated) body = body.slice(0, MAX_BODY_CHARS);
  const formFields = e.form_fields && Object.values(e.form_fields).some((v) => clean(v)) ? e.form_fields : null;
  return {
    source: e.source,
    message_id: clean(e.message_id),
    sender_name: clean(e.sender_name),
    sender_email: clean(e.sender_email).toLowerCase(),
    sender_phone: clean(e.sender_phone),
    subject: clean(e.subject),
    body,
    body_truncated: truncated,
    form_fields: formFields,
    received_at: isoOrNow(e.received_at),
    is_test: Boolean(e.is_test),
    gmail_id: e.gmail_id ?? null,
  };
}

/** n8n Form Trigger output (keys are the field labels). `executionId` makes the message id unique. */
export function fromForm(json, executionId) {
  const f = (key) => clean(json[FORM_FIELDS[key]]);
  return finalise({
    source: "webform",
    message_id: `form:${executionId}`,
    sender_name: f("name"),
    sender_email: f("email"),
    sender_phone: f("phone"),
    subject: "",
    body: f("message"),
    form_fields: { postcode: f("postcode"), service_needed: f("service") },
    received_at: json.submittedAt,
  });
}

/** n8n Gmail Trigger output, in either its simplified or full form. */
export function fromGmail(msg) {
  const fromObj = msg.from?.value?.[0];
  const from = fromObj
    ? { name: clean(fromObj.name), email: clean(fromObj.address).toLowerCase() }
    : parseAddress(msg.From ?? msg.from?.text ?? msg.headers?.from ?? "");
  const body = clean(msg.text) || htmlToText(msg.html) || clean(msg.textPlain) || clean(msg.snippet);
  const date = msg.date ?? (msg.internalDate ? Number(msg.internalDate) : undefined) ?? msg.headers?.date;
  return finalise({
    source: "email",
    message_id: `gmail:${msg.id}`,
    gmail_id: msg.id,
    sender_name: from.name,
    sender_email: from.email,
    sender_phone: "",
    subject: msg.subject ?? msg.Subject ?? msg.headers?.subject ?? "",
    body,
    form_fields: null,
    received_at: date,
  });
}

/** Test webhook body: an enquiry in the shape of eval/test-set/enquiries.json, plus a run id. */
export function fromTestWebhook(body) {
  if (!body || typeof body !== "object") throw new Error("Expected a JSON enquiry");
  if (!body.id || !body.run_id) throw new Error("Test enquiries need id and run_id");
  if (!["email", "webform"].includes(body.source)) throw new Error("source must be email or webform");
  return finalise({
    source: body.source,
    message_id: `test:${body.run_id}:${body.id}`,
    sender_name: body.sender?.name,
    sender_email: body.sender?.email,
    sender_phone: body.sender?.phone,
    subject: body.subject,
    body: body.body,
    form_fields: body.form_fields ?? null,
    received_at: body.received_at,
    is_test: true,
  });
}
