#!/usr/bin/env node
// Sets up the Supabase (or any Postgres) database from .env, printing no secrets:
//   1. connects with the admin URL (SUPABASE_DB_URL)
//   2. runs seed/sql/001_schema.sql, 002_seed.sql, 003_roles.sql (all idempotent)
//   3. gives the read-only mcp_readonly role a fresh random password and login
//   4. writes the read-only connection to DATABASE_URL / DATABASE_SSL in .env
//   5. connects as mcp_readonly and checks it can read but not write
//   6. the same for n8n's least-privilege role n8n_writer (N8N_DB_URL): replays every query the
//      workflows run (rolled back) and checks that deleting, rewriting and DDL are refused
//   7. the same for the demo page's role demo_web (DEMO_DB_URL): it may only run demo_view()
// Options: --keep-password  reuse the passwords already in DATABASE_URL / N8N_DB_URL instead of rotating them
// After a rotation: docker compose up -d mcp-server, and
//                   node scripts/n8n-credentials.mjs --update "Supabase Postgres (n8n writes)"
// Run: node scripts/db-setup.mjs   (after: node scripts/build-seed-sql.mjs if seed JSON changed)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ROOT, readEnv, updateEnv } from "./lib/dotenv.mjs";
import { checkForbidden, checkWorkflowQueries } from "./lib/n8n-role-check.mjs";
import { SQL } from "../n8n/build.mjs";

const require = createRequire(path.join(ROOT, "mcp-server", "package.json"));
const pg = require("pg");

const step = (msg) => console.log(`\n▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
};

const env = readEnv();
const adminUrl = env.SUPABASE_DB_URL;
if (!adminUrl) die("SUPABASE_DB_URL is empty in .env");

let admin;
try {
  admin = new URL(adminUrl.replace(/^postgresql:/, "postgres:"));
} catch {
  die("SUPABASE_DB_URL is not a valid URL (a password with @ : / ? # % must be URL-encoded)");
}
if (/^db\.[a-z0-9]+\.supabase\.co$/.test(admin.hostname)) {
  die("SUPABASE_DB_URL is the IPv6-only direct connection; use the Session pooler URI (Connect -> Session pooler)");
}

// Supabase's pooler identifies the project from the user name: postgres.<project-ref>
const isSupabasePooler = admin.hostname.endsWith(".pooler.supabase.com");
const projectRef = isSupabasePooler ? /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(admin.username))?.[1] : null;
if (isSupabasePooler && !projectRef) die("Pooler user name should be postgres.<project-ref>");

// Supabase's server certificates are signed by Supabase's own CA, so verification needs their CA file;
// the connection is still TLS-encrypted with no-verify.
const ssl = admin.hostname === "localhost" || admin.hostname === "127.0.0.1" ? false : { rejectUnauthorized: false };

const connect = async (connectionString) => {
  const client = new pg.Client({ connectionString, ssl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
};

step(`Connecting as admin to ${admin.hostname}:${admin.port || 5432}`);
let db;
try {
  db = await connect(adminUrl);
} catch (err) {
  die(`Could not connect: ${err.message}`);
}
// The project can be shared with other apps (their own schemas and roles): only ever touch public.
await db.query("set search_path = public, extensions");
const info = (await db.query("select current_user, split_part(version(), ' ', 2) as version")).rows[0];
ok(`connected as ${info.current_user}, Postgres ${info.version}`);

step("Applying schema, seed data and roles");
for (const file of ["001_schema.sql", "002_seed.sql", "003_roles.sql"]) {
  const sql = readFileSync(path.join(ROOT, "seed", "sql", file), "utf8");
  try {
    await db.query(sql);
    ok(file);
  } catch (err) {
    await db.end();
    die(`${file} failed: ${err.message}`);
  }
}
const counts = (
  await db.query(`select (select count(*) from services) s, (select count(*) from policies) p,
                         (select count(*) from service_area_districts) d, (select count(*) from customers) c,
                         (select count(*) from jobs) j`)
).rows[0];
ok(`${counts.s} services, ${counts.p} policies, ${counts.d} districts, ${counts.c} customers, ${counts.j} jobs`);

step("Setting up the read-only role mcp_readonly");
const keep = process.argv.includes("--keep-password");
let password;
if (keep && env.DATABASE_URL) {
  password = decodeURIComponent(new URL(env.DATABASE_URL).password);
  ok("keeping the existing password");
} else {
  password = randomBytes(24).toString("hex");
  await db.query(`alter role mcp_readonly with login password ${db.escapeLiteral(password)}`);
  ok("login enabled with a new random password");
}

step("Setting up n8n's least-privilege role n8n_writer");
let writerPassword;
let writerRotated = false;
if (keep && env.N8N_DB_URL) {
  writerPassword = decodeURIComponent(new URL(env.N8N_DB_URL).password);
  ok("keeping the existing password");
} else {
  writerPassword = randomBytes(24).toString("hex");
  await db.query(`alter role n8n_writer with login password ${db.escapeLiteral(writerPassword)}`);
  writerRotated = true;
  ok("login enabled with a new random password");
}

step("Setting up the demo page's role demo_web");
let demoPassword;
if (keep && env.DEMO_DB_URL) {
  demoPassword = decodeURIComponent(new URL(env.DEMO_DB_URL).password);
  ok("keeping the existing password");
} else {
  demoPassword = randomBytes(24).toString("hex");
  await db.query(`alter role demo_web with login password ${db.escapeLiteral(demoPassword)}`);
  ok("login enabled with a new random password");
}
await db.end();

const ro = new URL(admin.href);
ro.username = isSupabasePooler ? `mcp_readonly.${projectRef}` : "mcp_readonly";
ro.password = password;
ro.search = "?sslmode=no-verify";
if (ssl === false) ro.search = "";
const readOnlyUrl = ro.href;
const w = new URL(ro.href);
w.username = isSupabasePooler ? `n8n_writer.${projectRef}` : "n8n_writer";
w.password = writerPassword;
const writerUrl = w.href;
const dw = new URL(ro.href);
dw.username = isSupabasePooler ? `demo_web.${projectRef}` : "demo_web";
dw.password = demoPassword;
const demoUrl = dw.href;
updateEnv({ DATABASE_URL: readOnlyUrl, DATABASE_SSL: ssl === false ? "disable" : "no-verify", N8N_DB_URL: writerUrl, DEMO_DB_URL: demoUrl });
ok("wrote DATABASE_URL, DATABASE_SSL, N8N_DB_URL and DEMO_DB_URL to .env");

step("Checking the read-only connection");
let roDb;
try {
  roDb = await connect(readOnlyUrl);
} catch (err) {
  die(`mcp_readonly could not connect: ${err.message}`);
}
const who = (await roDb.query("select current_user")).rows[0].current_user;
const readable = (await roDb.query("select count(*)::int n from services")).rows[0].n;
ok(`connected as ${who}; can read ${readable} services`);
for (const [label, sql] of [
  ["write to customers", "insert into customers (first_name, last_name) values ('Test', 'Write')"],
  ["read enquiries", "select 1 from enquiries limit 1"],
]) {
  try {
    await roDb.query(sql);
    await roDb.end();
    die(`mcp_readonly was able to ${label}: the role is NOT read-only`);
  } catch (err) {
    if (!/permission denied/.test(err.message)) {
      await roDb.end();
      die(`unexpected error on "${label}": ${err.message}`);
    }
    ok(`cannot ${label} (permission denied)`);
  }
}
await roDb.end();

step("Checking the n8n_writer connection");
let wDb;
try {
  wDb = await connect(writerUrl);
} catch (err) {
  die(`n8n_writer could not connect: ${err.message}`);
}
ok(`connected as ${(await wDb.query("select current_user")).rows[0].current_user}`);
try {
  const passed = await checkWorkflowQueries(wDb, SQL);
  ok(`all ${passed.length} workflow queries allowed (replayed in a transaction, then rolled back)`);
} catch (err) {
  await wDb.end();
  die(`a workflow query is not allowed for n8n_writer: ${err.message}`);
}
const wrongly = await checkForbidden(wDb);
await wDb.end();
if (wrongly.length) die(`n8n_writer was able to: ${wrongly.join(", ")}`);
ok("cannot delete, truncate, rewrite messages/drafts/approvals, read audit details or create tables (permission denied)");

step("Checking the demo_web connection");
let dDb;
try {
  dDb = await connect(demoUrl);
} catch (err) {
  die(`demo_web could not connect: ${err.message}`);
}
ok(`connected as ${(await dDb.query("select current_user")).rows[0].current_user}`);
const unknown = (await dDb.query("select demo_view($1) as v", [randomBytes(32).toString("hex")])).rows[0].v;
if (unknown !== null) die("demo_view returned data for an unknown token");
ok("can run demo_view (an unknown link shows nothing)");
for (const [label, sql] of [
  ["read demo sessions", "select 1 from demo_sessions limit 1"],
  ["read enquiries", "select 1 from enquiries limit 1"],
  ["read customers", "select 1 from customers limit 1"],
  ["read the audit log", "select 1 from audit_log limit 1"],
  ["add a demo session", "insert into demo_sessions (token_hash, email, payload) values ('x', 'x@example.com', '{}')"],
  ["purge demo data", "select * from purge_demo_data(7)"],
  ["create a table", "create table demo_web_probe (id int)"],
]) {
  try {
    await dDb.query(sql);
    await dDb.end();
    die(`demo_web was able to ${label}`);
  } catch (err) {
    if (!/permission denied/.test(err.message)) {
      await dDb.end();
      die(`unexpected error on "${label}": ${err.message}`);
    }
  }
}
await dDb.end();
ok("cannot read or write any table, purge, or create anything (permission denied)");

console.log("\nDone. To make the MCP server read from the database, set DATA_SOURCE=postgres in .env.");
if (!keep) console.log("Passwords were rotated: restart the MCP server with  docker compose up -d mcp-server");
if (writerRotated) console.log('Give n8n the new n8n_writer password:  node scripts/n8n-credentials.mjs --update "Supabase Postgres (n8n writes)"');
