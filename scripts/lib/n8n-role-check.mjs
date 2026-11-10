// Proves the n8n_writer role can run every query the n8n workflows run, and nothing destructive.
// The positive check replays the workflow queries in pipeline order (intake -> classify -> draft ->
// card -> housekeeping -> approve -> reject attempt) with the same string parameters n8n sends, inside a transaction
// that is always rolled back, so it leaves no data behind.

const EXEC = "role-check";

/** Runs every workflow query; returns the steps that passed. Throws with the failing step's name. */
export async function checkWorkflowQueries(client, SQL) {
  const passed = [];
  const run = async (step, sql, params, expectRow = true) => {
    let res;
    try {
      res = await client.query(sql, params);
    } catch (err) {
      throw new Error(`${step}: ${err.message}`);
    }
    if (expectRow && !res.rows.length) throw new Error(`${step}: returned no rows`);
    passed.push(step);
    return res.rows[0] ?? null;
  };
  await client.query("begin");
  try {
    const messageId = `rolecheck:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const enquiryId = (await run("intake: insert enquiry", SQL.INSERT_SQL, [
      "webform", messageId, "Role Check", "role.check@example.com", "", "Role check", "Checking database permissions",
      "", new Date().toISOString(), "true", EXEC, "{}",
    ])).enquiry_id;
    if (!enquiryId) throw new Error("intake: insert enquiry returned no id");
    const classification = JSON.stringify({ category: "new_job_request", urgency: "normal", summary: "Role check", postcode: "BS6 6AL", service_ids: [] });
    await run("classify: save classification + audit", SQL.SAVE_SQL, [
      enquiryId, "classified", "new_job_request", "normal", "false", classification, EXEC, "classified", "{}", "role-check", "1", "1", "", "1",
    ]);
    await run("draft: load enquiry", SQL.LOAD_SQL, [enquiryId]);
    const draftId = (await run("draft: save draft + audit", SQL.SAVE_DRAFT_SQL, [
      enquiryId, "Re: Role check", "Hello", "", "[]", "high", "{}", "", "role-check", "false", "", "", "true", "drafted",
      EXEC, "drafted", "{}", "1", "1", "", "1",
    ])).draft_id;
    if (!draftId) throw new Error("draft: save draft returned no id");
    await run("approval: load for card", SQL.LOAD_CARD_SQL, [enquiryId, draftId]);
    await run("approval: save card + status", SQL.SAVE_CARD_SQL, [draftId, "C0000000", "1.1", enquiryId, "true", EXEC, "{}", "true"]);
    // Housekeeping: the reminder query (this enquiry is a test, so it isn't listed), a reminder and a hold release.
    await run("housekeeping: cards waiting for approval", SQL.WAITING_SQL, [], false);
    await run("housekeeping: log reminder", SQL.REMINDER_SQL, [enquiryId, EXEC, "approval_reminder", "{}"]);
    const release = await run("housekeeping: log release + find card", SQL.RELEASE_SQL, [enquiryId, EXEC, '{"holds":[]}']);
    // Only demo data older than the retention period: nothing here qualifies, but the call must be allowed.
    await run("housekeeping: purge old demo data", SQL.PURGE_SQL, [], false);
    if (release.slack_ts !== "1.1") throw new Error("housekeeping: log release + find card did not find the card");
    await run("interactions: load draft text (edit)", SQL.LOAD_DRAFT_TEXT_SQL, [draftId]);
    await run("interactions: claim draft", SQL.CLAIM_SQL, [draftId]);
    const service = (await client.query("select id from services order by id limit 1")).rows[0]?.id ?? "";
    const rec = await run("interactions: record decision (customer, job, approval)", SQL.RECORD_SQL, [
      enquiryId, draftId, "approved", "role-check", "", "Re: Role check", "Hello", "simulated", "sent", "true",
      "Role", "Check", "BS6 6AL", "true", service, "Role check", EXEC, "sent_simulated", "{}",
    ]);
    if (!rec.approval_id || !rec.new_customer_id || !rec.job_id) throw new Error("interactions: record decision did not create approval, customer and job");
    await run("interactions: log outcome", SQL.OUTCOME_SQL, [enquiryId, EXEC, "{}"]);
    // Already sent, so the reject claims nothing, but every table and column it touches is still checked.
    await run("interactions: record rejection", SQL.REJECT_SQL, [draftId, "role-check", "", "check", EXEC, "{}"], false);
    // The demo page: start, confirm, link to an enquiry, find its draft.
    const tokenHash = "0".repeat(48) + Date.now().toString(16).padStart(16, "0");
    const started = await run("demo: record pending session", SQL.DEMO_START_SQL, [tokenHash, "role.check@example.com", "Role Check", '{"message":"check"}', "1000000", "1000000"]);
    if (!started.session_id) throw new Error("demo: record pending session inserted nothing");
    const confirmed = await run("demo: confirm session", SQL.DEMO_CONFIRM_SQL, [tokenHash, "1000000"]);
    if (confirmed.id !== started.session_id) throw new Error("demo: confirm session did not confirm it");
    await run("demo: link session to enquiry", SQL.DEMO_LINK_SQL, [started.session_id, enquiryId]);
    const found = await run("demo: find the draft", SQL.DEMO_FIND_DRAFT_SQL, [tokenHash]);
    if (found.draft_id !== draftId) throw new Error("demo: find the draft did not find it");
  } finally {
    await client.query("rollback");
  }
  return passed;
}

/** Statements the role must NOT be allowed to run. `where false` and rollbacks mean nothing changes even if one were allowed. */
export const FORBIDDEN = [
  ["delete enquiries", "delete from enquiries where false"],
  ["delete audit rows", "delete from audit_log where false"],
  ["rewrite a customer's message", "update enquiries set body = body where false"],
  ["rewrite a draft", "update drafts set body = body where false"],
  ["change an approval", "update approvals set final_text = final_text where false"],
  ["change customers", "update customers set notes = notes where false"],
  ["read audit details", "select detail from audit_log limit 0"],
  ["change the audit log", "update audit_log set event = event where false"],
  ["delete demo sessions directly", "delete from demo_sessions where false"],
  ["rewrite a demo submission", "update demo_sessions set payload = payload where false"],
  ["read policies", "select 1 from policies limit 0"],
  ["truncate jobs", "begin; truncate jobs; rollback"],
  ["create a table", "begin; create table n8n_writer_probe (x int); rollback"],
];

/** Returns the forbidden statements that were (wrongly) allowed. */
export async function checkForbidden(client) {
  const allowed = [];
  for (const [label, sql] of FORBIDDEN) {
    try {
      await client.query(sql);
      allowed.push(label);
      await client.query("rollback").catch(() => {});
    } catch (err) {
      await client.query("rollback").catch(() => {});
      if (!/permission denied/.test(err.message)) throw new Error(`unexpected error on "${label}": ${err.message}`);
    }
  }
  return allowed;
}
