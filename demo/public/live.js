// The live page: polls the enquiry's state and shows each step as it happens. Everything from the
// server (including what the visitor and the model wrote) is shown with textContent, never as HTML.
// The page's private token is in the URL fragment, which is never sent to a server.
"use strict";

const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const GIVE_UP_MS = 10 * 60 * 1000;

const CATEGORY = {
  new_job_request: "New job", quote_request: "Quote request", emergency: "Emergency", complaint: "Complaint",
  existing_customer_followup: "Follow-up from a customer", spam: "Spam",
};
const FLAG = {
  gas_smell: "Gas smell", carbon_monoxide: "Carbon monoxide", flooding: "Flooding", uncontrolled_leak: "Uncontrolled leak",
  no_heating_or_hot_water: "No heating or hot water", no_water_supply: "No water supply", electrical_risk: "Electrical risk",
};
const TOOL = {
  get_services: "Looked up services and prices", check_service_area: "Checked the service area",
  get_available_slots: "Checked the diary", find_customer: "Looked for an existing customer record",
};
const PHASE = {
  starting: ["Starting", "Your enquiry is entering the pipeline.", "busy"],
  classifying: ["Reading your enquiry", "Claude Haiku is classifying it and judging the urgency.", "busy"],
  drafting: ["Drafting a reply", "Claude Sonnet is looking things up and writing a reply. This is the longest step: usually 20 to 60 seconds.", "busy"],
  posting: ["Posting for approval", "The draft is going to the team's Slack, where it waits for a person.", "busy"],
  awaiting_decision: ["Your turn", "The draft is ready. Read it, edit it if you like, and decide below.", "wait"],
  sending: ["Sending", "Sending the reply and updating the records.", "busy"],
  sent: ["Done", "", "done"],
  rejected: ["Rejected", "Nothing was sent. The enquiry is closed as rejected.", "done"],
  needs_person: ["Handed to a person", "The agent didn't produce a reply it could stand behind, so in the business a person would reply by hand. See why below.", "done"],
  archived: ["Filed as spam", "The agent judged this to be spam, so it wasn't drafted or posted. (An injection attempt would be flagged and still shown to a person.)", "done"],
  failed: ["Something failed", "The approved reply couldn't be sent. The demo's owner has been alerted.", "bad"],
  unconfirmed: ["Not started yet", "Open the link in your email and press \"Start my demo\".", "wait"],
  notfound: ["Link not found", "This demo link isn't valid, or its enquiry has been deleted (they're kept for 7 days).", "bad"],
  error: ["Can't reach the demo", "Retrying…", "bad"],
};

const el = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text !== undefined && text !== null) e.textContent = String(text);
  if (className) e.className = className;
  return e;
};
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
const show = (id, on = true) => { $(id).hidden = !on; };
const money = (n) => (n === null || n === undefined ? "–" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);
const secs = (ms) => (ms === null || ms === undefined ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const when = (iso) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(iso));

function facts(dl, rows) {
  clear(dl);
  for (const [k, v] of rows) {
    if (v === null || v === undefined || v === "") continue;
    dl.append(el("dt", k), el("dd", v));
  }
}

function setStatus(phase, extra) {
  const [title, text, tone] = PHASE[phase] ?? [phase, "", "wait"];
  $("status-title").textContent = title;
  $("status-text").textContent = extra ?? text;
  $("status").dataset.tone = tone;
}

function setStages(s) {
  const reached = {
    received: Boolean(s.steps?.length),
    classified: Boolean(s.classification),
    drafted: Boolean(s.draft) || ["needs_person", "archived"].includes(s.phase),
    decision: Boolean(s.decision),
    done: ["sent", "rejected", "needs_person", "archived", "failed"].includes(s.phase),
  };
  let current = true;
  for (const li of $("stages").children) {
    const done = reached[li.dataset.stage];
    li.className = done ? "done" : current ? "current" : "";
    if (!done) current = false;
  }
}

function renderEnquiry(s) {
  show("enquiry-card");
  facts($("enquiry-facts"), [["From", s.session.name], ["Postcode", s.session.postcode], ["About", s.session.service_needed]]);
  $("enquiry-message").textContent = s.session.message;
}

function renderClassification(s) {
  const c = s.classification;
  if (!c) return show("classification-card", false);
  show("classification-card");
  const badges = clear($("class-badges"));
  badges.append(el("span", CATEGORY[c.category] ?? c.category, "badge"));
  badges.append(el("span", `${c.urgency ?? "normal"} urgency`, `badge urgency-${c.urgency ?? "normal"}`));
  if (c.confidence) badges.append(el("span", `${c.confidence} confidence`, "badge muted"));
  $("class-summary").textContent = c.summary ?? "";
  facts($("class-facts"), [
    ["Why this urgency", c.urgency_reason],
    ["Service wanted", c.service_wanted],
    ["Postcode", c.postcode],
    ["Says they're a customer", c.claims_existing_customer ? "Yes" : null],
  ]);
  const flags = clear($("class-flags"));
  if (c.injection_suspected) {
    const box = el("div", null, "flag danger");
    box.append(el("strong", "Possible prompt injection: "), el("span", c.injection_evidence || "the message tries to give the agent instructions."));
    box.append(el("p", "The agent treats the message as data, never as orders, and the card is marked for a person to check.", "small"));
    flags.append(box);
  }
  for (const f of c.safety_flags ?? []) flags.append(el("div", `Safety: ${FLAG[f] ?? f}`, "flag warn"));
  if (c.vulnerable_occupant) flags.append(el("div", "Someone vulnerable may be affected", "flag warn"));
  if (c.urgency === "emergency") flags.append(el("div", "Emergency: the on-call team got an instant alert in Slack, before any reply was drafted.", "flag warn"));
}

function renderDraft(s) {
  const d = s.draft;
  if (!d) {
    if (s.phase === "needs_person" && s.steps.length) {
      show("draft-card");
      clear($("draft-tools")); clear($("draft-slots"));
      const checks = clear($("draft-checks"));
      checks.append(el("div", "No draft was saved for this enquiry, so it goes to a person to answer.", "flag warn"));
      show("draft-email", false);
    } else show("draft-card", false);
    return;
  }
  show("draft-card");
  // While the visitor decides, the draft is in the edit box below, so it isn't shown twice.
  show("draft-email", s.phase !== "awaiting_decision");
  const tools = clear($("draft-tools"));
  const used = d.tools_used ?? [];
  if (used.length) {
    tools.append(el("p", `Tools used (${used.length} call${used.length === 1 ? "" : "s"}):`, "small"));
    const ul = el("ul", null, "chips");
    for (const t of used) ul.append(el("li", `${TOOL[t.name] ?? t.name}${t.is_error ? " (failed)" : ""}`));
    tools.append(ul);
  } else tools.append(el("p", "No tools were needed for this reply.", "small"));

  const checks = clear($("draft-checks"));
  const p = d.checks?.prices;
  if (p) checks.append(el("div", p.ok ? (p.amounts?.length ? `Prices checked: £${p.amounts.join(", £")} all match the price list` : "No prices quoted") : `Price not found in the tools' data: £${(p.unsupported ?? []).join(", £")}`, `check ${p.ok ? "ok" : "bad"}`));
  const ct = d.checks?.contacts;
  if (ct) checks.append(el("div", ct.ok ? "No one else's contact details" : "Contains contact details that aren't yours or the business's", `check ${ct.ok ? "ok" : "bad"}`));
  if (d.needs_review && d.review_reason) {
    for (const r of String(d.review_reason).split("; ")) checks.append(el("div", `For a person to check: ${r}`, "check warn"));
  }

  const slots = clear($("draft-slots"));
  if (Array.isArray(d.offered_slots) && d.offered_slots.length) {
    slots.append(el("p", "Appointment slots offered (from the live diary):", "small"));
    const ul = el("ul", null, "chips");
    for (const x of d.offered_slots) ul.append(el("li", x.label || when(x.start)));
    slots.append(ul);
  }
  $("draft-subject").textContent = d.subject ? `Subject: ${d.subject}` : "";
  $("draft-body").textContent = d.body ?? "";
}

let formFilled = false;
function renderDecision(s) {
  const waiting = s.phase === "awaiting_decision";
  show("decision-card", waiting);
  if (waiting && !formFilled && s.draft) {
    $("edit-subject").value = s.draft.subject ?? "";
    $("edit-body").value = s.draft.body ?? "";
    formFilled = true;
  }
  const d = s.decision;
  show("outcome-card", Boolean(d) || ["needs_person", "archived"].includes(s.phase));
  const box = clear($("outcome"));
  if (!d) {
    if (s.phase === "needs_person") box.append(el("p", "In the business, this enquiry now waits in Slack for someone to reply by hand."));
    if (s.phase === "archived") box.append(el("p", "Spam is filed away without a reply. Nothing was posted or sent."));
    return;
  }
  const o = d.outcome ?? {};
  if (d.decision === "rejected") {
    box.append(el("p", "You rejected the draft: nothing was sent."));
    if (d.reason) box.append(el("p", `Reason recorded: ${d.reason}`, "small"));
    box.append(el("p", "The Slack card now shows it as rejected.", "small"));
    return;
  }
  const sentText = o.status === "simulated" || d.send_mode === "simulated"
    ? "this is a test address, so nothing was emailed (simulated)."
    : s.phase === "failed" ? "but the email couldn't be sent." : "it's been emailed to you. Check your inbox.";
  const how = d.decision === "edited" ? "You edited the draft and approved it:" : "You approved the draft:";
  box.append(el("p", `${how} ${sentText}`, s.phase === "failed" ? "flag danger" : "flag ok"));
  const ul = el("ul", null, "list");
  if (o.customer_created) ul.append(el("li", "A customer record was created for you."));
  if (o.job_created) ul.append(el("li", "A job was logged against it."));
  if (o.holds) ul.append(el("li", `${o.holds} tentative hold${o.holds === 1 ? "" : "s"} added to the bookings calendar.`));
  ul.append(el("li", "The Slack card was updated with the outcome."));
  box.append(ul);
  if (d.final_text) {
    box.append(el("p", "What was sent:", "small"));
    const mail = el("div", null, "email");
    mail.append(el("p", d.final_subject ? `Subject: ${d.final_subject}` : "", "email-subject"), el("p", d.final_text, "email-body"));
    box.append(mail);
  }
}

function renderTimeline(s) {
  const steps = s.steps ?? [];
  show("timeline-card", steps.length > 0);
  const ol = clear($("timeline"));
  for (const t of steps) {
    const li = el("li");
    li.append(el("span", `+${secs(t.after_ms) || "0 ms"}`, "at"), el("span", t.label, "what"));
    const meta = [t.duration_ms ? `took ${secs(t.duration_ms)}` : "", t.cost_usd !== null ? money(t.cost_usd) : ""].filter(Boolean).join(" · ");
    if (meta) li.append(el("span", meta, "meta"));
    ol.append(li);
  }
  $("total").textContent = s.totals?.cost_usd !== null && s.totals?.cost_usd !== undefined
    ? `AI cost for this enquiry: ${money(s.totals.cost_usd)} · ${secs(s.totals.elapsed_ms)} from start to last step` : "";
}

let calendarShown = false;
function renderCalendar(s) {
  if (calendarShown || !s.calendar_url) return;
  calendarShown = true;
  show("calendar-card");
  const frame = document.createElement("iframe");
  frame.src = s.calendar_url;
  frame.title = "Harbourline Bookings calendar (read-only)";
  frame.referrerPolicy = "no-referrer";
  $("calendar").append(frame);
}

let latest = null; // the last state, to tell whether the visitor edited the draft
const lastDraft = () => latest?.draft ?? null;

function render(s) {
  latest = s;
  setStatus(s.phase, s.phase === "sent" ? (s.decision?.send_mode === "simulated" ? "Approved (simulated: test address)." : "The reply is on its way to your inbox.") : s.stuck ? "This is taking longer than usual. It will carry on; you can leave this page open." : undefined);
  setStages(s);
  renderEnquiry(s);
  renderClassification(s);
  renderDraft(s);
  renderDecision(s);
  renderTimeline(s);
  renderCalendar(s);
  if (s.retention_days) $("retention").textContent = `Your enquiry and the records made from it are deleted automatically after ${s.retention_days} days.`;
}

let timer = null;
let startedAt = Date.now();
async function poll() {
  clearTimeout(timer);
  try {
    const res = await fetch("/demo/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token }) });
    if (res.status === 404) return setStatus("notfound");
    if (!res.ok) throw new Error(String(res.status));
    const s = await res.json();
    render(s);
    if (s.settled || Date.now() - startedAt > GIVE_UP_MS) return;
  } catch {
    setStatus("error");
  }
  timer = setTimeout(poll, POLL_MS);
}

async function decide(kind) {
  const err = $("decide-error");
  err.hidden = true;
  const subject = $("edit-subject").value;
  const body = $("edit-body").value;
  const draft = lastDraft();
  const edited = draft && (subject.trim() !== (draft.subject ?? "").trim() || body.trim() !== (draft.body ?? "").trim());
  const payload = kind === "reject_submit" ? { kind, reason: $("reject-reason").value } : edited ? { kind: "edit_submit", subject, body } : { kind: "approve" };
  for (const b of document.querySelectorAll("#decide-form button")) b.disabled = true;
  setStatus("sending", kind === "reject_submit" ? "Recording your decision." : undefined);
  try {
    const res = await fetch("/demo/api/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token, ...payload }) });
    const r = await res.json().catch(() => ({}));
    if (!r.ok && res.status !== 409) {
      err.textContent = r.error ?? "That didn't work. Please try again.";
      err.hidden = false;
    }
  } catch {
    err.textContent = "Couldn't reach the demo. Please try again.";
    err.hidden = false;
  } finally {
    for (const b of document.querySelectorAll("#decide-form button")) b.disabled = false;
  }
  startedAt = Date.now();
  await poll();
  if (!$("outcome-card").hidden) $("outcome-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("decide-form").addEventListener("submit", (e) => { e.preventDefault(); decide("approve"); });
$("reject-open").addEventListener("click", () => { show("reject-box"); $("reject-reason").focus(); });
$("reject").addEventListener("click", () => decide("reject_submit"));
const relabel = () => {
  const d = lastDraft();
  const edited = d && ($("edit-body").value.trim() !== (d.body ?? "").trim() || $("edit-subject").value.trim() !== (d.subject ?? "").trim());
  $("approve").textContent = edited ? "Send my edited version" : "Approve and send to me";
};
$("edit-body").addEventListener("input", relabel);
$("edit-subject").addEventListener("input", relabel);

if (!/^[A-Za-z0-9_-]{43}$/.test(token)) setStatus("notfound");
else poll();
