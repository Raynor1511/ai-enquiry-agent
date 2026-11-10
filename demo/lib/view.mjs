// Turns demo_view() (seed/sql/001_schema.sql) into what the live page shows: which stage the enquiry
// is at, whether the page should keep polling, and a readable timeline with timing and cost.

/** Where an enquiry is, from its status in the database. `settled`: nothing more happens without the visitor. */
const PHASES = {
  received: { phase: "classifying", settled: false },
  classified: { phase: "drafting", settled: false },
  drafted: { phase: "posting", settled: false },
  awaiting_approval: { phase: "awaiting_decision", settled: true },
  sending: { phase: "sending", settled: false },
  sent: { phase: "sent", settled: true },
  rejected: { phase: "rejected", settled: true },
  needs_review: { phase: "needs_person", settled: true },
  archived: { phase: "archived", settled: true },
  failed: { phase: "failed", settled: true },
};

const STEP_LABELS = {
  "intake/received": "Enquiry received and saved",
  "classify/classified": "Classified (Claude Haiku)",
  "classify/classified_with_overrides": "Classified (Claude Haiku), then raised by the safety rules",
  "classify/classification_failed": "Classification failed",
  "draft/drafted": "Reply drafted (Claude Sonnet, using the business's tools)",
  "draft/drafted_needs_review": "Reply drafted, with points for a person to check",
  "draft/draft_failed": "Drafting failed",
  "approval/card_posted": "Approval card posted in the team's Slack",
  "approval/card_failed": "Slack card could not be posted",
  "approval/sent": "Approved, and the reply emailed",
  "approval/sent_simulated": "Approved (test address, so nothing emailed)",
  "approval/send_failed": "Approved, but the email failed",
  "approval/rejected": "Rejected: nothing sent",
  "housekeeping/holds_released": "Unconfirmed calendar holds released",
};
const HIDDEN_STEPS = new Set(["approval/outcome", "housekeeping/approval_reminder", "housekeeping/approval_reminder_failed"]);

/** How long after confirming an enquiry should have reached the decision stage. */
export const STUCK_AFTER_MS = 5 * 60 * 1000;

export function shapeState(view, { calendarUrl = null, now = Date.now() } = {}) {
  if (!view) return { found: false };
  const s = view.session ?? {};
  const e = view.enquiry ?? null;
  const out = {
    found: true,
    retention_days: view.retention_days ?? 7,
    session: {
      status: s.status, name: s.name ?? "", confirmed_at: s.confirmed_at ?? null,
      postcode: s.payload?.postcode ?? "", service_needed: s.payload?.service_needed ?? "", message: s.payload?.message ?? "",
    },
    calendar_url: calendarUrl,
  };
  if (s.status !== "confirmed") return { ...out, phase: "unconfirmed", settled: true };
  if (!e) {
    const waited = now - Date.parse(s.confirmed_at ?? "");
    return { ...out, phase: "starting", settled: false, stuck: waited > STUCK_AFTER_MS };
  }
  const p = PHASES[e.status] ?? { phase: e.status, settled: true };
  const timeline = Array.isArray(view.timeline) ? view.timeline : [];
  const start = Date.parse(timeline[0]?.at ?? e.received_at);
  const steps = timeline
    .filter((t) => !HIDDEN_STEPS.has(`${t.step}/${t.event}`))
    .map((t) => ({
      label: STEP_LABELS[`${t.step}/${t.event}`] ?? `${t.step}: ${String(t.event).replace(/_/g, " ")}`,
      after_ms: Math.max(0, Date.parse(t.at) - start),
      duration_ms: t.duration_ms ?? null,
      model: t.model ?? null,
      cost_usd: t.cost_usd === null || t.cost_usd === undefined ? null : Number(t.cost_usd),
    }));
  const costs = steps.map((x) => x.cost_usd).filter((c) => c !== null && !Number.isNaN(c));
  const last = timeline.length ? Date.parse(timeline.at(-1).at) : start;
  return {
    ...out,
    phase: p.phase,
    settled: p.settled,
    stuck: !p.settled && now - start > STUCK_AFTER_MS,
    classification: e.classification ?? null,
    urgency: e.urgency ?? null,
    category: e.category ?? null,
    is_suspicious: Boolean(e.is_suspicious),
    draft: view.draft ?? null,
    decision: view.decision ?? null,
    steps,
    totals: { cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null, elapsed_ms: Math.max(0, last - start) },
  };
}
