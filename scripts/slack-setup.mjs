#!/usr/bin/env node
// Checks the Slack app setup from .env and finishes it, printing no secrets:
//   - the bot token works (auth.test) and the signing secret looks right
//   - both channels exist and the bot is a member of each
//   - writes SLACK_APPROVAL_CHANNEL_ID / SLACK_ALERTS_CHANNEL_ID to .env
//   - with --test-message, posts one test message to the approval channel
// Run: node scripts/slack-setup.mjs [--test-message]
import { readEnv, updateEnv } from "./lib/dotenv.mjs";

const env = readEnv();
const ok = (m) => console.log(`  ✓ ${m}`);
const die = (m) => {
  console.error(`  ✗ ${m}`);
  process.exit(1);
};

if (!/^xoxb-/.test(env.SLACK_BOT_TOKEN ?? "")) die("SLACK_BOT_TOKEN should be the Bot User OAuth Token (starts with xoxb-)");
if (!/^[0-9a-f]{32}$/.test(env.SLACK_SIGNING_SECRET ?? "")) die("SLACK_SIGNING_SECRET should be 32 hex characters (Basic Information -> App Credentials)");
ok("token and signing secret have the right format");

async function slack(method, params = {}, { post = false } = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  const init = { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } };
  if (post) {
    init.method = "POST";
    init.headers["content-type"] = "application/json; charset=utf-8";
    init.body = JSON.stringify(params);
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  }
  const body = await (await fetch(url, init)).json();
  if (!body.ok) throw new Error(`${method}: ${body.error}${body.needed ? ` (needs scope ${body.needed})` : ""}`);
  return body;
}

try {
  const auth = await slack("auth.test");
  ok(`bot "${auth.user}" connected to workspace "${auth.team}"`);

  const channels = [];
  let cursor;
  do {
    const page = await slack("conversations.list", { types: "public_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
    channels.push(...page.channels);
    cursor = page.response_metadata?.next_cursor;
  } while (cursor);

  const ids = {};
  for (const [nameKey, idKey] of [["SLACK_APPROVAL_CHANNEL", "SLACK_APPROVAL_CHANNEL_ID"], ["SLACK_ALERTS_CHANNEL", "SLACK_ALERTS_CHANNEL_ID"]]) {
    const wanted = (env[nameKey] ?? "").replace(/^#/, "").trim().toLowerCase();
    if (!wanted) die(`${nameKey} is empty in .env`);
    const channel = channels.find((c) => c.name === wanted);
    if (!channel) die(`no public channel called #${wanted}; check the name in .env (${nameKey})`);
    if (!channel.is_member) die(`the bot isn't in #${wanted} yet: type /invite @${auth.user} in that channel`);
    ids[idKey] = channel.id;
    ok(`#${wanted} found (${channel.id}), bot is a member`);
  }
  updateEnv(ids);
  ok("wrote SLACK_APPROVAL_CHANNEL_ID and SLACK_ALERTS_CHANNEL_ID to .env");

  if (process.argv.includes("--test-message")) {
    await slack(
      "chat.postMessage",
      {
        channel: ids.SLACK_APPROVAL_CHANNEL_ID,
        text: "Harbourline Enquiries is connected.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: ":white_check_mark: *Harbourline Enquiries is connected.*\nDrafted replies will appear in this channel for you to approve, edit or reject." } },
          { type: "context", elements: [{ type: "mrkdwn", text: "Test message from scripts/slack-setup.mjs · Harbourline is a fictional demo company" }] },
        ],
      },
      { post: true },
    );
    ok(`posted a test message to #${env.SLACK_APPROVAL_CHANNEL.replace(/^#/, "")}`);
  }
} catch (err) {
  die(err.message);
}
