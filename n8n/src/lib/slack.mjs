// Slack message building. Pure functions: inlined into n8n Code nodes by n8n/build.mjs.

/**
 * Escape text from customers before it goes into Slack mrkdwn. Slack only treats &, < and > as control
 * characters; escaping them stops "<!channel>", "<!here>" or fake links like "<https://x|Click>".
 */
export function slackEscape(text, max = 600) {
  const s = String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function ukTimeShort(iso) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

/** chat.postMessage body for the instant emergency alert. */
export function emergencyAlert(channel, enquiry, c) {
  const who = [enquiry.sender_name, enquiry.sender_email, enquiry.sender_phone].filter(Boolean).map((x) => slackEscape(x, 120)).join(" · ") || "unknown sender";
  const flags = (c.safety_flags ?? []).map((f) => f.replace(/_/g, " ")).join(", ") || "none";
  return {
    channel,
    text: `EMERGENCY: ${slackEscape(c.summary, 150)}`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "🚨 Emergency enquiry", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: `*${slackEscape(c.summary, 300)}*\n${slackEscape(c.urgency_reason, 300)}` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*From*\n${who}` },
          { type: "mrkdwn", text: `*Postcode*\n${slackEscape(c.postcode || "not given", 20)}` },
          { type: "mrkdwn", text: `*Safety flags*\n${slackEscape(flags, 200)}` },
          { type: "mrkdwn", text: `*Received*\n${ukTimeShort(enquiry.received_at)} by ${enquiry.source === "email" ? "email" : "web form"}${c.vulnerable_occupant ? "\n:warning: vulnerable occupant" : ""}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `>${slackEscape(enquiry.body, 500).replace(/\n+/g, "\n>")}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Call the customer if needed. A holding reply is being drafted for approval. · Harbourline is a fictional demo company." }] },
    ],
  };
}
