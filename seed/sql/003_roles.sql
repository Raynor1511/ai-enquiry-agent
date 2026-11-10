-- Database roles: read-only for the MCP server, least-privilege writer for n8n.
-- The admin user (SUPABASE_DB_URL) is only used by setup scripts, never by a running service.
-- Logins and random passwords are set by scripts/db-setup.mjs (passwords are never committed).
-- The Supabase project can be shared with other apps (each with its own schema and roles). Everything
-- here lives in the public schema and touches only this project's roles; the search path is pinned so
-- unqualified names can never resolve to another app's schema.
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Read-only role for the MCP server.
--
-- The MCP server connects as this role, which can only SELECT the five reference tables.
-- It cannot see enquiries, drafts, approvals or the audit log, and cannot write anything.
-- (The server also wraps every query in a READ ONLY transaction, a second safeguard.)
-- On Supabase, connect through the pooler with the user name  mcp_readonly.<project-ref>
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_readonly') then
    create role mcp_readonly nologin;
  end if;
end $$;

grant usage on schema public to mcp_readonly;
revoke all on all tables in schema public from mcp_readonly;
grant select on services, policies, service_area_districts, customers, jobs to mcp_readonly;
grant execute on function normalise_uk_phone(text), name_key(text) to mcp_readonly;

-- RLS is enabled on every table (001_schema.sql), so the role also needs SELECT policies.
do $$
declare
  t text;
begin
  foreach t in array array['services', 'policies', 'service_area_districts', 'customers', 'jobs'] loop
    execute format('drop policy if exists mcp_readonly_select on %I', t);
    execute format('create policy mcp_readonly_select on %I for select to mcp_readonly using (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Least-privilege role for n8n (Phase 5).
--
-- n8n connects as this role instead of the admin user. It can do exactly what the workflows do
-- (n8n/build.mjs; scripts/db-setup.mjs runs every one of those queries as this role to prove it):
--   * read the tables it needs, add enquiries, drafts, approvals, customers, jobs and audit rows
--   * change only an enquiry's status/classification/customer link and a draft's Slack location
-- It cannot delete or truncate anything (except demo data past its retention, through purge_demo_data),
-- rewrite a customer's message, a draft or an approval,
-- read audit details, touch policies or the service area, or create or alter tables.
-- db-setup.mjs gives it a random password and writes the connection to N8N_DB_URL in .env.
-- On Supabase, connect through the pooler with the user name  n8n_writer.<project-ref>
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'n8n_writer') then
    create role n8n_writer nologin;
  end if;
end $$;
-- No workflow query takes more than a moment; a stuck one must not hold locks.
alter role n8n_writer set statement_timeout = '30s';
alter role n8n_writer set idle_in_transaction_session_timeout = '60s';

grant usage on schema public to n8n_writer;
revoke create on schema public from n8n_writer;
-- Start from nothing (this also clears column privileges), then grant exactly what is used.
revoke all on all tables in schema public from n8n_writer;
grant select on services to n8n_writer;
grant select, insert on enquiries, drafts, approvals, customers, jobs to n8n_writer;
grant update (status, category, urgency, is_suspicious, classification, customer_id) on enquiries to n8n_writer;
grant update (slack_channel, slack_ts) on drafts to n8n_writer;
-- The demo page's pending submissions: n8n records them and marks them confirmed (docs/demo.md).
grant select, insert on demo_sessions to n8n_writer;
grant update (status, enquiry_id, confirmed_at) on demo_sessions to n8n_writer;
-- The audit log is append-only for n8n. It may read the ids its inserts return and what happened
-- when (housekeeping reminders look for the last card and reminder), but never the details.
grant insert on audit_log to n8n_writer;
grant select (id, enquiry_id, step, event, created_at) on audit_log to n8n_writer;
grant execute on function normalise_uk_phone(text), name_key(text) to n8n_writer;
-- The one deletion n8n may make: demo data past its retention period (a SECURITY DEFINER function
-- that touches only demo enquiries and sessions). Nobody else may run it; on Supabase that includes
-- the public API roles, which get EXECUTE on new functions by default.
revoke all on function purge_demo_data(integer) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function purge_demo_data(integer) from anon, authenticated';
  end if;
end $$;
grant execute on function purge_demo_data(integer) to n8n_writer;

-- Row level security: matching policies for this role only (anon/authenticated still get nothing).
do $$
declare
  t text;
begin
  foreach t in array array['services', 'enquiries', 'drafts', 'approvals', 'customers', 'jobs', 'audit_log', 'demo_sessions'] loop
    execute format('drop policy if exists n8n_writer_select on %I', t);
    execute format('create policy n8n_writer_select on %I for select to n8n_writer using (true)', t);
  end loop;
  foreach t in array array['enquiries', 'drafts', 'approvals', 'customers', 'jobs', 'audit_log', 'demo_sessions'] loop
    execute format('drop policy if exists n8n_writer_insert on %I', t);
    execute format('create policy n8n_writer_insert on %I for insert to n8n_writer with check (true)', t);
  end loop;
  foreach t in array array['enquiries', 'drafts', 'demo_sessions'] loop
    execute format('drop policy if exists n8n_writer_update on %I', t);
    execute format('create policy n8n_writer_update on %I for update to n8n_writer using (true) with check (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Supabase's public API roles. Supabase grants them every new table in the public schema by default;
-- row level security already gives them no rows, and this removes the grants themselves from this
-- project's tables as a second layer. (Only these tables: other apps' schemas and roles are untouched.)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on services, policies, service_area_districts, customers, jobs, enquiries, drafts, approvals, audit_log, demo_sessions from anon, authenticated';
  end if;
end $$;
