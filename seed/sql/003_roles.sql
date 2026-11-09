-- Read-only database role for the MCP server.
--
-- The MCP server connects as this role, which can only SELECT the five reference tables.
-- It cannot see enquiries, drafts, approvals or the audit log, and cannot write anything.
-- (The server also wraps every query in a READ ONLY transaction, a second safeguard.)
--
-- After running this file, enable login with a password you choose (do NOT commit it):
--   alter role mcp_readonly with login password '<a long random password>';
-- On Supabase, connect through the pooler with the user name  mcp_readonly.<project-ref>

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
