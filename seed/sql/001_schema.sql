-- Harbourline AI Enquiry Agent: database schema (Postgres 15+ / Supabase).
-- Safe to re-run: everything uses IF NOT EXISTS / OR REPLACE.
--
-- Reference data (read by the MCP server):  services, policies, service_area_districts, customers, jobs
-- Pipeline data (written by n8n only):      enquiries, drafts, approvals, audit_log

-- ---------------------------------------------------------------------------
-- Helper functions. These mirror mcp-server/src/domain/{phone,text}.ts exactly.
-- ---------------------------------------------------------------------------

-- "+44 (0)7700 900102" -> "07700900102"
create or replace function normalise_uk_phone(p text) returns text
language sql immutable parallel safe as $$
  select case
    when d = '' then null
    when d like '0044%' then '0' || substr(d, 5)
    when d like '44%' and length(d) = 12 then '0' || substr(d, 3)
    else d
  end
  from (select regexp_replace(replace(coalesce(p, ''), '(0)', ''), '\D', '', 'g') as d) s
$$;

-- "  Grace   O'Neill " -> "grace oneill"
create or replace function name_key(t text) returns text
language sql immutable parallel safe as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '[^[:alpha:][:space:]]', '', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table if not exists services (
  id                        text primary key,
  name                      text not null,
  category                  text not null check (category in ('heating', 'gas', 'plumbing', 'bathrooms', 'emergency')),
  description               text not null,
  price_basis               text not null check (price_basis in ('fixed', 'range', 'from')),
  price_min                 numeric(10, 2) not null check (price_min >= 0),
  price_max                 numeric(10, 2) check (price_max is null or price_max >= price_min),
  price_note                text,
  typical_duration_minutes  integer,
  requires_survey           boolean not null default false,
  keywords                  text[] not null default '{}',
  active                    boolean not null default true,
  updated_at                timestamptz not null default now()
);

create table if not exists policies (
  id          text primary key,
  title       text not null,
  category    text not null,
  applies_to  text[] not null default '{all}',
  body        text not null,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

create table if not exists service_area_districts (
  district                 text primary key check (district = upper(district)),
  zone                     text not null check (zone in ('core', 'extended')),
  area_name                text not null,
  travel_surcharge         numeric(10, 2) not null default 0,
  response_target_minutes  integer not null
);

create table if not exists customers (
  id              text primary key default ('cus_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12)),
  first_name      text,
  last_name       text,
  company_name    text,
  customer_type   text not null default 'residential' check (customer_type in ('residential', 'landlord', 'agent', 'commercial')),
  email           text,
  phone           text,
  address_line1   text,
  town            text,
  postcode        text,
  customer_since  date not null default current_date,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (first_name is not null or last_name is not null or company_name is not null)
);
create index if not exists customers_email_idx on customers (lower(trim(email)));
create index if not exists customers_phone_idx on customers (normalise_uk_phone(phone));
create index if not exists customers_name_idx on customers (name_key(coalesce(first_name, '') || ' ' || coalesce(last_name, '')));

-- ---------------------------------------------------------------------------
-- Pipeline data
-- ---------------------------------------------------------------------------

create table if not exists enquiries (
  id             uuid primary key default gen_random_uuid(),
  source         text not null check (source in ('email', 'webform')),
  -- Gmail message id (or a hash for web forms). Unique, so the same message is never processed twice.
  message_id     text unique,
  sender_name    text,
  sender_email   text,
  sender_phone   text,
  subject        text,
  body           text not null,
  form_fields    jsonb,
  received_at    timestamptz not null,
  status         text not null default 'received' check (status in (
                   'received', 'classified', 'drafted', 'awaiting_approval',
                   'sent', 'rejected', 'archived', 'needs_review', 'failed')),
  category       text check (category in ('new_job_request', 'quote_request', 'emergency', 'complaint', 'existing_customer_followup', 'spam')),
  urgency        text check (urgency in ('emergency', 'high', 'normal', 'low')),
  is_suspicious  boolean not null default false,
  classification jsonb,
  customer_id    text references customers (id) on delete set null,
  is_test        boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists enquiries_status_idx on enquiries (status, received_at desc);

create table if not exists jobs (
  id                 text primary key default ('job_' || substr(md5(random()::text || clock_timestamp()::text), 1, 12)),
  customer_id        text not null references customers (id) on delete restrict,
  service_id         text references services (id),
  status             text not null check (status in ('enquiry', 'quoted', 'scheduled', 'completed', 'cancelled')),
  job_date           date,
  scheduled_start    timestamptz,
  scheduled_end      timestamptz,
  amount             numeric(10, 2),
  reference          text,
  engineer           text,
  notes              text,
  source_enquiry_id  uuid references enquiries (id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists jobs_customer_idx on jobs (customer_id, job_date desc);

create table if not exists drafts (
  id              uuid primary key default gen_random_uuid(),
  enquiry_id      uuid not null references enquiries (id) on delete cascade,
  version         integer not null default 1,
  body            text not null,
  reasoning       text,
  tools_used      jsonb not null default '[]',
  confidence      text check (confidence in ('low', 'medium', 'high')),
  -- Result of checking every price in the draft against prices the tools returned.
  grounding_check jsonb,
  proposed_slot   jsonb,
  model           text,
  created_at      timestamptz not null default now(),
  unique (enquiry_id, version)
);

create table if not exists approvals (
  id          uuid primary key default gen_random_uuid(),
  enquiry_id  uuid not null references enquiries (id) on delete cascade,
  draft_id    uuid references drafts (id) on delete set null,
  decision    text not null check (decision in ('approved', 'edited', 'rejected')),
  decided_by  text not null,
  final_text  text,
  reason      text,
  decided_at  timestamptz not null default now()
);

create table if not exists audit_log (
  id                     bigint generated always as identity primary key,
  enquiry_id             uuid references enquiries (id) on delete set null,
  workflow_execution_id  text,
  step                   text not null,
  event                  text not null,
  detail                 jsonb,
  model                  text,
  input_tokens           integer,
  output_tokens          integer,
  cost_usd               numeric(12, 6),
  duration_ms            integer,
  created_at             timestamptz not null default now()
);
create index if not exists audit_log_enquiry_idx on audit_log (enquiry_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists customers_updated_at on customers;
create trigger customers_updated_at before update on customers for each row execute function set_updated_at();
drop trigger if exists enquiries_updated_at on enquiries;
create trigger enquiries_updated_at before update on enquiries for each row execute function set_updated_at();
drop trigger if exists services_updated_at on services;
create trigger services_updated_at before update on services for each row execute function set_updated_at();
drop trigger if exists policies_updated_at on policies;
create trigger policies_updated_at before update on policies for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security. On Supabase this stops the public anon/authenticated API keys
-- reading anything. The table owner (n8n's connection) is unaffected; the MCP server's
-- read-only role gets explicit SELECT policies in 003_roles.sql.
-- ---------------------------------------------------------------------------
alter table services               enable row level security;
alter table policies               enable row level security;
alter table service_area_districts enable row level security;
alter table customers              enable row level security;
alter table jobs                   enable row level security;
alter table enquiries              enable row level security;
alter table drafts                 enable row level security;
alter table approvals              enable row level security;
alter table audit_log              enable row level security;
