import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyAlert, slackEscape } from "../src/lib/slack.mjs";

test("customer text cannot ping channels or inject links", () => {
  assert.equal(slackEscape("<!channel> <https://evil.example|Click> & co"), "&lt;!channel&gt; &lt;https://evil.example|Click&gt; &amp; co");
  assert.equal(slackEscape("x".repeat(10), 5), "xxxx…");
});

test("the emergency alert includes the essentials and escapes everything from the customer", () => {
  const msg = emergencyAlert(
    "C123",
    { sender_name: "Amira <!here>", sender_email: "amira@example.com", sender_phone: "", source: "webform", received_at: "2026-11-12T19:42:00Z", body: "Strong smell of gas\nin the kitchen" },
    { summary: "Gas smell in kitchen, BS6", urgency_reason: "Possible gas leak", postcode: "BS6", safety_flags: ["gas_smell"], vulnerable_occupant: false },
  );
  assert.equal(msg.channel, "C123");
  const json = JSON.stringify(msg);
  assert.ok(!json.includes("<!here>"), "no raw mention");
  assert.match(json, /gas smell/);
  assert.match(json, /BS6/);
  assert.match(json, />Strong smell of gas\\n>in the kitchen/);
  assert.equal(msg.unfurl_links, false);
});
