#!/usr/bin/env node
// Deletes test data, and optionally real enquiry data, from Supabase (and the matching calendar holds
// and Slack approval cards). Prints counts only, never personal data.
//
//   node scripts/clear-test-data.mjs                     dry run: what would go (nothing is deleted)
//   node scripts/clear-test-data.mjs --apply             delete evaluation enquiries (is_test) and
//                                                        synthetic leftovers from dev checks
//   ... --live                                           also real enquiries: their drafts, approvals,
//                                                        audit rows, jobs, the customers created from
//                                                        them, their tentative calendar holds and their
//                                                        Slack approval cards
//   ... --older-than 90                                  only enquiries received more than 90 days ago
//   ... --keep-customers                                 keep customers and jobs (with --live --older-than:
//                                                        a retention clean-up of old enquiries only)
//   ... --live --email someone@example.com               one person's data (an erasure request): their
//                                                        enquiries and everything above, plus any customer
//                                                        record with that address and its jobs
//
// Seed data (services, policies, the 30 demo customers and their job history) is never touched.
// The dry run performs the same deletes inside a transaction and rolls it back, so its counts
// (including cascades) are exactly what --apply would remove.
// Not covered: emails in the demo Gmail mailbox and Slack messages other than approval cards
// (alerts, thread replies): remove those by hand (see docs/data-protection.md).
// Uses the admin connection (SUPABASE_DB_URL): n8n's own role cannot delete anything, by design.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, readEnv } from "./lib/dotenv.mjs";

const args = process.argv.slice(2);
const FLAGS = ["--apply", "--live", "--keep-customers"];
const VALUES = ["--older-than", "--email"];
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (FLAGS.includes(args[i])) opts[args[i]] = true;
  else if (VALUES.includes(args[i]) && args[i + 1] !== undefined) opts[args[i]] = args[++i];
  else fail(`Unknown or incomplete option: ${args[i]}. See the comment at the top of this file.`);
}
const apply = Boolean(opts["--apply"]);
const live = Boolean(opts["--live"]);
const keepCustomers = Boolean(opts["--keep-customers"]);
const olderThan = opts["--older-than"] === undefined ? null : Number(opts["--older-than"]);
if (olderThan !== null && !(Number.isInteger(olderThan) && olderThan >= 0)) fail("--older-than needs a whole number of days");
const email = opts["--email"] === undefined ? null : String(opts["--email"]).trim().toLowerCase();
if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("--email needs an email address");
if (email !== null && !live) fail("--email is for real data: add --live");
if (email !== null && keepCustomers) fail("--email removes the person's customer record too; don't combine it with --keep-customers");

const env = readEnv();
if (!env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is empty in .env");
  process.exit(1);
}
const pg = createRequire(path.join(ROOT, "mcp-server", "package.json"))("pg");
const db = new pg.Client({ connectionString: env.SUPABASE_DB_URL, ssl: /localhost|127\.0\.0\.1/.test(env.SUPABASE_DB_URL) ? false : { rejectUnauthorized: false } });
await db.connect();
// The project can be shared with other apps (their own schemas and roles): only ever touch public.
await db.query("set search_path = public, extensions");

console.log(`Scope: ${email ? "one sender's enquiries and customer records" : live ? "all enquiries (test and real)" : "evaluation enquiries and synthetic leftovers"}${olderThan !== null ? `, received more than ${olderThan} day(s) ago` : ""}${keepCustomers ? ", keeping customers and jobs" : ""}`);
console.log(apply ? "Deleting." : "Dry run: nothing will be deleted. Add --apply to delete.");

const counts = {};
let holds = [];
let cards = [];
try {
  await db.query("begin");
  // The enquiries in scope, kept in a temporary table for the rest of the transaction.
  await db.query(`create temporary table doomed on commit drop as
    select id, message_id, is_test from enquiries
     where ($1::boolean or is_test or message_id like 'synthetic:%' or message_id like 'rolecheck:%')
       and ($2::int is null or received_at < now() - make_interval(days => $2::int))
       and ($3::text is null or lower(trim(sender_email)) = $3::text)`, [live, olderThan, email]);
  const n = async (sql) => Number((await db.query(sql)).rows[0].n);
  counts.enquiries_test = await n(`select count(*) n from doomed where is_test`);
  counts.enquiries_real = await n(`select count(*) n from doomed where not is_test`);
  // Approval cards to delete from Slack, before the drafts go.
  cards = (await db.query(`select distinct slack_channel, slack_ts from drafts where enquiry_id in (select id from doomed) and slack_ts is not null`)).rows;
  // Customers that exist only because one of these enquiries was approved (never seed customers),
  // and for an erasure request any customer record with the person's address. None with --keep-customers.
  await db.query(`create temporary table doomed_customers on commit drop as
    select c.id from customers c
     where not $1::boolean
       and ((c.notes like 'Created from approved enquiry %'
             and substr(c.notes, length('Created from approved enquiry ') + 1) in (select message_id from doomed))
            or ($2::text is not null and lower(trim(c.email)) = $2::text))`, [keepCustomers, email]);
  counts.audit_rows = (await db.query(`delete from audit_log where enquiry_id in (select id from doomed)`)).rowCount;
  // With --keep-customers, jobs survive their enquiry (the link is cleared by the foreign key).
  counts.jobs = (await db.query(`delete from jobs where (not $1::boolean and source_enquiry_id in (select id from doomed)) or customer_id in (select id from doomed_customers)`, [keepCustomers])).rowCount;
  counts.approvals = (await db.query(`delete from approvals where enquiry_id in (select id from doomed)`)).rowCount;
  counts.drafts = (await db.query(`delete from drafts where enquiry_id in (select id from doomed)`)).rowCount;
  // Demo page submissions (docs/demo.md): those of the enquiries in scope; for an erasure request every
  // one with the address (confirmed or not); with --live, all of them (or those older than the cut-off);
  // otherwise the ones with addresses that can't receive mail (left by dev checks).
  counts.demo_sessions = (await db.query(`delete from demo_sessions s
     where s.enquiry_id in (select id from doomed) or ('demo:' || s.id) in (select message_id from doomed)
        or ($3::text is not null and lower(trim(s.email)) = $3::text)
        or ($1::boolean and $3::text is null and ($2::int is null or s.created_at < now() - make_interval(days => $2::int)))
        or (not $1::boolean and (split_part(lower(s.email), '@', 2) ~ '(^|\\.)(example|test|invalid|localhost)$'
                                 or split_part(lower(s.email), '@', 2) ~ '(^|\\.)example\\.(com|net|org|co\\.uk)$'))`, [live, olderThan, email])).rowCount;
  const enq = (await db.query(`delete from enquiries where id in (select id from doomed)`)).rowCount;
  counts.customers_created_from_enquiries = (await db.query(`delete from customers where id in (select id from doomed_customers)`)).rowCount;
  if (enq !== counts.enquiries_test + counts.enquiries_real) throw new Error("enquiry count changed during the run; nothing was deleted");
  // Enquiries left after the deletes (whether or not they are committed): a hold whose enquiry isn't
  // among them belongs to a deleted enquiry or to one that is already gone.
  const remainingIds = new Set((await db.query(`select id from enquiries`)).rows.map((r) => r.id));
  await db.query(apply ? "commit" : "rollback");

  // Calendar holds for these enquiries (and holds whose enquiry no longer exists), real scope only:
  // test enquiries are never approved, so they never have holds.
  if (live && env.GOOGLE_CALENDAR_ID && env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    const authFile = path.join(ROOT, "mcp-server", "dist", "calendar", "googleAuth.js");
    if (!existsSync(authFile)) {
      console.log("  (calendar holds skipped: build the MCP server first with  cd mcp-server && npm run build)");
    } else {
      const { CALENDAR_EVENTS, loadServiceAccountKey, ServiceAccountTokenSource } = await import(pathToFileURL(authFile).href);
      const tokens = new ServiceAccountTokenSource(await loadServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE), CALENDAR_EVENTS);
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;
      const now = Date.now();
      let pageToken = "";
      do {
        const q = new URLSearchParams({ singleEvents: "true", maxResults: "2500", timeMin: new Date(now - 400 * 86400000).toISOString(), timeMax: new Date(now + 400 * 86400000).toISOString() });
        if (pageToken) q.set("pageToken", pageToken);
        const r = await fetch(`${base}?${q}`, { headers: { authorization: `Bearer ${await tokens.token()}` } });
        if (!r.ok) throw new Error(`calendar list failed: HTTP ${r.status}`);
        const page = await r.json();
        for (const ev of page.items ?? []) {
          const tag = ev.extendedProperties?.private?.harbourlineHold;
          if (tag && !remainingIds.has(tag)) holds.push(ev.id);
        }
        pageToken = page.nextPageToken ?? "";
      } while (pageToken);
      if (apply) {
        for (const id of holds) await fetch(`${base}/${encodeURIComponent(id)}?sendUpdates=none`, { method: "DELETE", headers: { authorization: `Bearer ${await tokens.token()}` } });
      }
    }
  }
  if (apply && cards.length && env.SLACK_BOT_TOKEN) {
    let deleted = 0;
    for (const c of cards) {
      const r = await (await fetch("https://slack.com/api/chat.delete", { method: "POST", headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel: c.slack_channel, ts: c.slack_ts }) })).json();
      if (r.ok || r.error === "message_not_found") deleted++;
    }
    counts.slack_cards_deleted = deleted;
  }
} catch (err) {
  await db.query("rollback").catch(() => {});
  await db.end();
  console.error(`  ✗ ${err.message}`);
  process.exit(1);
}
await db.end();

const verb = apply ? "deleted" : "would delete";
console.log(`  enquiries ${verb}: ${counts.enquiries_test + counts.enquiries_real} (evaluation/synthetic ${counts.enquiries_test}, real ${counts.enquiries_real})`);
console.log(`  drafts ${counts.drafts} · approvals ${counts.approvals} · audit rows ${counts.audit_rows} · jobs ${counts.jobs} · customer records ${counts.customers_created_from_enquiries} · demo submissions ${counts.demo_sessions}`);
if (live) console.log(`  calendar holds: ${holds.length} · Slack approval cards: ${cards.length}${apply && counts.slack_cards_deleted !== undefined ? ` (${counts.slack_cards_deleted} removed)` : ""}`);
if (live) console.log("  Not touched: emails in the demo Gmail mailbox, Slack alerts and thread replies (remove by hand).");
