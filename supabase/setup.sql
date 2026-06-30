-- ============================================================
-- Founders OS — Database Setup
-- ============================================================
-- Run this once in your Supabase SQL Editor to set up
-- the complete Founders OS schema from scratch.
--
-- Prerequisites:
--   1. Enable the "vector" extension in Supabase:
--      Dashboard → Database → Extensions → enable "vector"
--      (OR it will be enabled automatically by this script)
--
--   2. Set EMBEDDING_DIM in your .env before running.
--      The vector(1024) dimension below must match EMBEDDING_DIM.
--      Provider defaults:
--        bedrock / amazon.nova-2-multimodal-embeddings-v1:0 → 1024
--        openai  / text-embedding-3-small                  → 1536
--        ollama  / nomic-embed-text                        → 768
--      If you use a different dimension, find and replace
--      all occurrences of "vector(1024)" in this file before running.
-- ============================================================

-- ────────────────────────────────────────
-- Extensions
-- ────────────────────────────────────────

create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";

-- ────────────────────────────────────────
-- Shared trigger: auto-update updated_at
-- ────────────────────────────────────────

create or replace function update_updated_at()
returns trigger
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ============================================================
-- CRM SCHEMA
-- ============================================================

-- ── Enum types ───────────────────────────────────────────────

create type customer_type as enum (
  'client', 'partner', 'vendor', 'investor', 'other'
);

create type customer_phase as enum (
  'prospect', 'lead', 'opportunity', 'customer',
  'renewal', 'churned', 'inactive'
);

create type interaction_type as enum (
  'email', 'call', 'meeting', 'demo',
  'support', 'event', 'note'
);

create type follow_up_priority as enum (
  'low', 'medium', 'high', 'urgent'
);

-- ── Customers ────────────────────────────────────────────────

create table customers (
  id                uuid          primary key default uuid_generate_v4(),
  company_id        text          not null default 'default',
  organization_name text          not null,
  customer_type     customer_type not null default 'other',
  customer_phase    customer_phase not null default 'prospect',
  address_line1     text,
  address_line2     text,
  city              text,
  state             text,
  zip               text,
  website           text,
  notes             text,
  tags              text[]        default '{}',
  deleted_at        timestamptz,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint customers_id_company_unique unique (id, company_id)
);

create index idx_customers_company_id on customers (company_id);
create index idx_customers_deleted on customers (deleted_at) where deleted_at is not null;
create index idx_customers_type       on customers (customer_type);
create index idx_customers_phase      on customers (customer_phase);
create index idx_customers_tags       on customers using gin (tags);
create index idx_customers_fts on customers
  using gin (to_tsvector('english',
    coalesce(organization_name, '') || ' ' ||
    coalesce(notes, '') || ' ' ||
    coalesce(city, '') || ' ' ||
    coalesce(state, '')
  ));

create trigger trg_customers_updated
  before update on customers
  for each row execute function update_updated_at();

-- ── Contacts ─────────────────────────────────────────────────

create table contacts (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  customer_id uuid        not null references customers(id) on delete cascade,
  first_name  text        not null,
  last_name   text        not null,
  email       text,
  phone       text,
  role        text,
  is_primary  boolean     not null default false,
  is_active   boolean     not null default true,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint contacts_id_company_unique unique (id, company_id)
);

create index idx_contacts_deleted    on contacts (deleted_at) where deleted_at is not null;
create index idx_contacts_customer   on contacts (customer_id);
create index idx_contacts_email      on contacts (email) where email is not null;
create index idx_contacts_company_id on contacts (company_id);

create trigger trg_contacts_updated
  before update on contacts
  for each row execute function update_updated_at();

-- ── Interactions ─────────────────────────────────────────────

create table interactions (
  id               uuid             primary key default uuid_generate_v4(),
  company_id       text             not null default 'default',
  customer_id      uuid             not null references customers(id) on delete cascade,
  contact_id       uuid             references contacts(id) on delete set null,
  interaction_type interaction_type not null,
  subject          text,
  body             text,
  interaction_date timestamptz      not null default now(),
  deleted_at       timestamptz,
  created_at       timestamptz      not null default now()
);

create index idx_interactions_company    on interactions (company_id);
create index idx_interactions_customer   on interactions (customer_id);
create index idx_interactions_contact_id on interactions (contact_id);
create index idx_interactions_date       on interactions (interaction_date desc);
create index idx_interactions_type       on interactions (interaction_type);
create index idx_interactions_deleted    on interactions (deleted_at) where deleted_at is not null;

-- ── Task enums ───────────────────────────────────────────────

create type task_status as enum (
  'todo', 'in_progress', 'blocked', 'done'
);

create type task_scope as enum (
  'personal', 'org'
);

create type task_entity_type as enum (
  'customer', 'contact', 'interaction',
  'transaction', 'contract', 'memory'
);

-- ── Tasks ────────────────────────────────────────────────────

create table tasks (
  id              uuid              primary key default uuid_generate_v4(),
  company_id      text              not null default 'default',
  title           text              not null,
  description     text,
  status          task_status       not null default 'todo',
  priority        follow_up_priority not null default 'medium',
  scope           task_scope        not null default 'org',
  created_by      text              not null default 'default',
  assigned_to     text,
  blocked_reason  text,
  blocked_by_task_id uuid           references tasks(id) on delete set null,
  due_date        date,
  completed_at    timestamptz,
  archived_at     timestamptz,
  deleted_at      timestamptz,
  tags            text[]            not null default '{}',
  created_at      timestamptz       not null default now(),
  updated_at      timestamptz       not null default now(),
  constraint tasks_id_company_unique unique (id, company_id)
);

create index idx_tasks_company     on tasks (company_id);
create index idx_tasks_status      on tasks (status);
create index idx_tasks_scope       on tasks (scope);
create index idx_tasks_assigned    on tasks (assigned_to) where assigned_to is not null;
create index idx_tasks_created_by  on tasks (created_by);
create index idx_tasks_due_date    on tasks (due_date) where status != 'done';
create index idx_tasks_priority    on tasks (priority);
create index idx_tasks_tags        on tasks using gin (tags);
create index idx_tasks_blocked_by  on tasks (blocked_by_task_id) where blocked_by_task_id is not null;
create index idx_tasks_archived   on tasks (company_id) where archived_at is not null;
create index idx_tasks_deleted    on tasks (deleted_at) where deleted_at is not null;
create index idx_tasks_fts on tasks using gin (
  to_tsvector('english',
    coalesce(title, '') || ' ' || coalesce(description, '')
  )
);

create trigger trg_tasks_updated
  before update on tasks
  for each row execute function update_updated_at();

-- ── Task Links ───────────────────────────────────────────────

create table task_links (
  id           uuid             primary key default uuid_generate_v4(),
  company_id   text             not null default 'default',
  task_id      uuid             not null references tasks(id) on delete cascade,
  entity_type  task_entity_type not null,
  entity_id    text             not null,
  created_at   timestamptz      not null default now()
);

create index idx_task_links_company on task_links (company_id);
create index idx_task_links_task   on task_links (task_id);
create index idx_task_links_entity on task_links (entity_type, entity_id);
create unique index idx_task_links_unique
  on task_links (task_id, entity_type, entity_id);

-- ── Task Notes ───────────────────────────────────────────────

create table task_notes (
  id         uuid        primary key default uuid_generate_v4(),
  task_id    uuid        not null references tasks(id) on delete cascade,
  user_id    text        not null default 'default',
  note       text        not null,
  created_at timestamptz not null default now()
);

create index idx_task_notes_task on task_notes (task_id);

-- ── Tag Registry ─────────────────────────────────────────────

create table tag_registry (
  id          uuid       primary key default uuid_generate_v4(),
  company_id  text       not null default 'default',
  name        text       not null,
  slug        text       not null,
  color       text,
  description text,
  scope       task_scope not null default 'org',
  archived    boolean    not null default false,
  deleted_at  timestamptz,
  created_by  text       not null default 'default',
  created_at  timestamptz not null default now()
);

create unique index idx_tag_registry_slug     on tag_registry (company_id, slug);
create index        idx_tag_registry_company  on tag_registry (company_id);
create index        idx_tag_registry_archived on tag_registry (company_id) where archived = true;
create index        idx_tag_registry_deleted  on tag_registry (deleted_at) where deleted_at is not null;

-- ── Playbooks ────────────────────────────────────────────────

create table playbooks (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  name        text        not null,
  slug        text        not null,
  description text,
  archived    boolean     not null default false,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, slug),
  constraint playbooks_id_company_unique unique (id, company_id)
);

create index idx_playbooks_company  on playbooks (company_id);
create index idx_playbooks_archived on playbooks (company_id) where archived = true;
create index idx_playbooks_deleted  on playbooks (deleted_at) where deleted_at is not null;

create trigger trg_playbooks_updated
  before update on playbooks
  for each row execute function update_updated_at();

-- ── Playbook Steps ───────────────────────────────────────────

create table playbook_steps (
  id            uuid               primary key default uuid_generate_v4(),
  playbook_id   uuid               not null references playbooks(id) on delete cascade,
  order_index   integer            not null default 0,
  type          text               not null check (type in ('native_task', 'external_action')),
  title         text               not null,
  description   text,
  assignee      text,
  due_offset    integer,
  priority      follow_up_priority not null default 'medium',
  connector     text,
  action        text,
  params        jsonb,
  fallback_task text,
  archived      boolean            not null default false,
  deleted_at    timestamptz,
  created_at    timestamptz        not null default now()
);

create index idx_playbook_steps_playbook on playbook_steps (playbook_id, order_index);
create index idx_playbook_steps_deleted  on playbook_steps (deleted_at) where deleted_at is not null;

-- ── Playbook Runs ────────────────────────────────────────────

create table playbook_runs (
  id            uuid        primary key default uuid_generate_v4(),
  playbook_id   uuid        references playbooks(id) on delete set null,
  company_id    text        not null default 'default',
  customer_id   uuid,
  started_by    text        not null default 'default',
  start_date    date        not null,
  status        text        not null default 'running'
                              check (status in ('running', 'complete', 'partial')),
  execution_log jsonb       not null default '[]',
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_playbook_runs_company  on playbook_runs (company_id);
create index idx_playbook_runs_playbook on playbook_runs (playbook_id);
create index idx_playbook_runs_customer on playbook_runs (customer_id) where customer_id is not null;

-- ── Projects ─────────────────────────────────────────────────

create table projects (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  name        text        not null,
  slug        text        not null,
  tag_name    text,
  status      text        not null default 'active',
  description text,
  created_by  text        not null default 'default',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  updated_at  timestamptz not null default now(),
  constraint chk_projects_status check (status in ('active', 'paused', 'completed', 'archived'))
);

create unique index idx_projects_company_slug   on projects (company_id, slug);
create index        idx_projects_company_status on projects (company_id, status);
create index        idx_projects_deleted        on projects (deleted_at) where deleted_at is not null;

create trigger trg_projects_updated
  before update on projects
  for each row execute function update_updated_at();

-- ── customer_summary view ────────────────────────────────────

create or replace view customer_summary as
select
  c.id,
  c.organization_name,
  c.customer_type,
  c.customer_phase,
  c.city,
  c.state,
  c.tags,
  c.company_id,
  c.created_at,
  c.updated_at,
  (
    select json_build_object(
      'name', ct.first_name || ' ' || ct.last_name,
      'email', ct.email,
      'role', ct.role
    )
    from contacts ct
    where ct.customer_id = c.id
      and ct.is_primary = true
      and ct.is_active = true
      and ct.deleted_at is null
    limit 1
  ) as primary_contact,
  (
    select max(i.interaction_date)
    from interactions i
    where i.customer_id = c.id
      and i.deleted_at is null
  ) as last_interaction_date,
  (
    select count(*)::int
    from tasks t
    join task_links tl on tl.task_id = t.id
    where tl.entity_type = 'customer'
      and tl.entity_id = c.id::text
      and t.status in ('todo', 'in_progress', 'blocked')
      and t.deleted_at is null
  ) as open_tasks
from customers c
where c.deleted_at is null;

-- ── Tag helper RPCs ──────────────────────────────────────────

create or replace function rename_tag_in_tasks(
  p_company_id text,
  p_old_name   text,
  p_new_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update tasks
    set tags = array_replace(tags, p_old_name, p_new_name)
    where company_id = p_company_id
      and p_old_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function rename_tag_in_customers(
  p_company_id text,
  p_old_name   text,
  p_new_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update customers
    set tags = array_replace(tags, p_old_name, p_new_name)
    where company_id = p_company_id
      and p_old_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function rename_tag_in_accounts(
  p_company_id text,
  p_old_name   text,
  p_new_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_accounts
    set tags = array_replace(tags, p_old_name, p_new_name)
    where company_id = p_company_id
      and p_old_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function rename_tag_in_categories(
  p_company_id text,
  p_old_name   text,
  p_new_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_categories
    set tags = array_replace(tags, p_old_name, p_new_name)
    where company_id = p_company_id
      and p_old_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function rename_tag_in_transactions(
  p_company_id text,
  p_old_name   text,
  p_new_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_transactions
    set tags = array_replace(tags, p_old_name, p_new_name)
    where company_id = p_company_id
      and p_old_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function remove_tag_from_tasks(
  p_company_id text,
  p_tag_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update tasks
    set tags = array_remove(tags, p_tag_name)
    where company_id = p_company_id
      and p_tag_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function remove_tag_from_customers(
  p_company_id text,
  p_tag_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update customers
    set tags = array_remove(tags, p_tag_name)
    where company_id = p_company_id
      and p_tag_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function remove_tag_from_accounts(
  p_company_id text,
  p_tag_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_accounts
    set tags = array_remove(tags, p_tag_name)
    where company_id = p_company_id
      and p_tag_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function remove_tag_from_categories(
  p_company_id text,
  p_tag_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_categories
    set tags = array_remove(tags, p_tag_name)
    where company_id = p_company_id
      and p_tag_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;

create or replace function remove_tag_from_transactions(
  p_company_id text,
  p_tag_name   text
) returns int
set search_path = public
as $$
declare affected int;
begin
  update financial_transactions
    set tags = array_remove(tags, p_tag_name)
    where company_id = p_company_id
      and p_tag_name = any(tags);
  get diagnostics affected = row_count;
  return affected;
end;
$$ language plpgsql;


-- ============================================================
-- MEMORY SCHEMA
-- ============================================================
-- user_id = 'org'                     → shared, visible to all team members
-- user_id = FOUNDERS_OS_USER_ID value → personal, visible only to that user
-- created_by                          → original author (used for delete scoping)

create table memories (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  user_id     text        not null,
  scope       text        not null check (scope in ('org', 'personal')),
  project     text,
  content     text        not null,
  embedding   vector(1024),   -- change to match your EMBEDDING_DIM
  source_tool text,
  created_by  text        not null default 'unknown',
  metadata    jsonb       default '{}',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- HNSW index for fast cosine similarity search
create index if not exists memories_embedding_hnsw_idx
  on memories using hnsw (embedding vector_cosine_ops);

create index idx_memories_company_id on memories (company_id);
create index memories_user_scope_idx on memories (user_id, scope);
create index memories_project_idx    on memories (project);
create index memories_created_by_idx on memories (created_by);

create trigger memories_updated_at
  before update on memories
  for each row execute function update_updated_at();

-- ── RPC: match_memories ──────────────────────────────────────
-- Vector similarity search with scope, project, metadata, and pagination filters.

create or replace function match_memories(
  query_embedding       vector(1024),   -- change to match your EMBEDDING_DIM
  user_id_filter        text,
  scope_filter          text        default null,
  project_filter        text        default null,
  match_count           int         default 10,
  min_score             float       default 0.35,
  source_tool_filter    text        default null,
  created_after_filter  timestamptz default null,
  created_before_filter timestamptz default null,
  offset_param          int         default 0,
  company_id_filter     text        default null
)
returns table (
  id          uuid,
  user_id     text,
  scope       text,
  project     text,
  content     text,
  source_tool text,
  score       float,
  created_at  timestamptz
)
language plpgsql
set search_path = public, extensions
as $$
begin
  return query
  select
    m.id,
    m.user_id,
    m.scope,
    m.project,
    m.content,
    m.source_tool,
    1 - (m.embedding <=> query_embedding) as score,
    m.created_at
  from memories m
  where
    (company_id_filter is null or m.company_id = company_id_filter)
    and (
      (
        scope_filter is null
        and (m.user_id = user_id_filter or m.user_id = 'org')
      )
      or (scope_filter = 'personal' and m.user_id = user_id_filter)
      or (scope_filter = 'org'      and m.user_id = 'org')
    )
    and (project_filter is null or m.project = project_filter)
    and (1 - (m.embedding <=> query_embedding)) >= min_score
    and (source_tool_filter is null or m.source_tool = source_tool_filter)
    and (created_after_filter is null or m.created_at >= created_after_filter)
    and (created_before_filter is null or m.created_at <= created_before_filter)
  order by m.embedding <=> query_embedding
  limit match_count
  offset offset_param;
end;
$$;


-- ============================================================
-- FINANCIAL SCHEMA
-- ============================================================

create type category_type_financial as enum ('income', 'expense');

-- ── financial_categories ─────────────────────────────────────

create table financial_categories (
  id         uuid                    primary key default uuid_generate_v4(),
  company_id text                    not null default 'default',
  name       text                    not null,
  type       category_type_financial not null,
  tags       text[]                  not null default '{}',
  archived   boolean                 not null default false,
  deleted_at timestamptz,
  created_at timestamptz             not null default now(),
  updated_at timestamptz             not null default now(),
  unique (company_id, name),
  constraint financial_categories_id_company_unique unique (id, company_id)
);

create index idx_financial_categories_company on financial_categories (company_id);
create index idx_financial_categories_type    on financial_categories (company_id, type);
create index idx_fin_categories_deleted       on financial_categories (deleted_at) where deleted_at is not null;

create trigger trg_financial_categories_updated
  before update on financial_categories
  for each row execute function update_updated_at();

-- ── financial_accounts ───────────────────────────────────────

create table financial_accounts (
  id              uuid          primary key default uuid_generate_v4(),
  company_id      text          not null default 'default',
  name            text          not null,
  balance         decimal(19,4) not null default 0,
  initial_balance decimal(19,4) not null default 0,
  tags            text[]        not null default '{}',
  archived        boolean       not null default false,
  deleted_at      timestamptz,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now(),
  unique (company_id, name),
  constraint financial_accounts_id_company_unique unique (id, company_id)
);

create index idx_financial_accounts_company on financial_accounts (company_id);
create index idx_fin_accounts_deleted      on financial_accounts (deleted_at) where deleted_at is not null;

create trigger trg_financial_accounts_updated
  before update on financial_accounts
  for each row execute function update_updated_at();

-- ── financial_transactions ───────────────────────────────────
-- amount is SIGNED: positive = income, negative = expense

create table financial_transactions (
  id                     uuid          primary key default uuid_generate_v4(),
  company_id             text          not null default 'default',
  date                   date          not null,
  description            text          not null,
  amount                 decimal(19,4) not null,
  category_id            uuid          not null references financial_categories(id) on delete restrict,
  account_id             uuid          not null references financial_accounts(id)   on delete restrict,
  transfer_to_account_id uuid          references financial_accounts(id)            on delete set null,
  customer_id            uuid          references customers(id)                     on delete set null,
  exclude_from_reports   boolean       not null default false,
  tags                   text[]        not null default '{}',
  archived               boolean       not null default false,
  deleted_at             timestamptz,
  created_at             timestamptz   not null default now(),
  updated_at             timestamptz   not null default now()
);

create index idx_financial_transactions_company     on financial_transactions (company_id);
create index idx_financial_transactions_date        on financial_transactions (company_id, date desc);
create index idx_financial_transactions_category    on financial_transactions (category_id);
create index idx_financial_transactions_account     on financial_transactions (account_id);
create index idx_financial_transactions_transfer_to on financial_transactions (transfer_to_account_id);
create index idx_financial_transactions_customer    on financial_transactions (customer_id);
create index idx_fin_tx_archived                 on financial_transactions (company_id) where archived = true;
create index idx_fin_transactions_deleted        on financial_transactions (deleted_at) where deleted_at is not null;

create trigger trg_financial_transactions_updated
  before update on financial_transactions
  for each row execute function update_updated_at();

-- ── RPC: create_financial_transaction ───────────────────────
-- Atomically inserts a transaction and updates the account balance.

create or replace function create_financial_transaction(
  p_company_id             text,
  p_date                   date,
  p_description            text,
  p_amount                 decimal(19,4),
  p_category_id            uuid,
  p_account_id             uuid,
  p_transfer_to_account_id uuid    default null,
  p_exclude_from_reports   boolean default false,
  p_customer_id            uuid    default null
)
returns financial_transactions
language plpgsql
set search_path = public
as $$
declare
  v_transaction financial_transactions;
begin
  insert into financial_transactions
    (company_id, date, description, amount, category_id, account_id,
     transfer_to_account_id, exclude_from_reports, customer_id)
  values
    (p_company_id, p_date, p_description, p_amount, p_category_id, p_account_id,
     p_transfer_to_account_id, p_exclude_from_reports, p_customer_id)
  returning * into v_transaction;

  update financial_accounts
    set balance = balance + p_amount
    where id = p_account_id;

  return v_transaction;
end;
$$;

-- ── RPC: delete_financial_transaction ───────────────────────
-- Safely deletes a transaction and reverses its balance impact.

create or replace function delete_financial_transaction(
  p_company_id     text,
  p_transaction_id uuid
)
returns financial_transactions
language plpgsql
set search_path = public
as $$
declare
  v_transaction financial_transactions;
begin
  select * into v_transaction
  from financial_transactions
  where id = p_transaction_id
    and company_id = p_company_id
  for update;

  if not found then
    raise exception 'Transaction % not found for company %',
      p_transaction_id, p_company_id;
  end if;

  update financial_accounts
    set balance = balance - v_transaction.amount
    where id = v_transaction.account_id;

  delete from financial_transactions
    where id = p_transaction_id;

  return v_transaction;
end;
$$;

-- ── RPC: soft_delete_financial_transaction ─────────────────
-- Reverses balance and sets deleted_at instead of removing row.

create or replace function soft_delete_financial_transaction(
  p_company_id     text,
  p_transaction_id uuid
)
returns financial_transactions
language plpgsql
set search_path = public
as $$
declare
  v_transaction financial_transactions;
begin
  select * into v_transaction
  from financial_transactions
  where id = p_transaction_id
    and company_id = p_company_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Transaction % not found for company %',
      p_transaction_id, p_company_id;
  end if;

  update financial_accounts
    set balance = balance - v_transaction.amount
    where id = v_transaction.account_id;

  update financial_transactions
    set deleted_at = now()
    where id = p_transaction_id
  returning * into v_transaction;

  return v_transaction;
end;
$$;

-- ── RPC: restore_financial_transaction_balance ─────────────
-- Re-applies balance when restoring a soft-deleted transaction.

create or replace function restore_financial_transaction_balance(
  p_account_id uuid,
  p_amount     numeric
)
returns void
language plpgsql
set search_path = public
as $$
begin
  update financial_accounts
    set balance = balance + p_amount
    where id = p_account_id;
end;
$$;

-- ── View: financial_pl_summary ───────────────────────────────

create or replace view financial_pl_summary as
select
  t.company_id,
  date_trunc('month', t.date)  as month,
  c.name                        as category,
  c.type                        as category_type,
  sum(t.amount)                 as total
from financial_transactions t
join financial_categories c on c.id = t.category_id
where t.exclude_from_reports = false
  and t.archived = false
  and t.deleted_at is null
group by t.company_id, date_trunc('month', t.date), c.name, c.type;

-- ── View: financial_pl_by_customer_summary ───────────────────

create or replace view financial_pl_by_customer_summary as
select
  t.company_id,
  date_trunc('month', t.date)  as month,
  t.customer_id,
  cust.organization_name        as customer_name,
  c.name                        as category,
  c.type                        as category_type,
  sum(t.amount)                 as total
from financial_transactions t
join financial_categories c on c.id = t.category_id
left join customers cust on cust.id = t.customer_id
where t.exclude_from_reports = false
  and t.archived = false
  and t.deleted_at is null
group by t.company_id, date_trunc('month', t.date), t.customer_id,
         cust.organization_name, c.name, c.type;

-- ── financial_access_level + company_members + audit_log ─────

create type financial_access_level as enum ('none', 'read', 'write');

create table company_members (
  id               uuid                   primary key default uuid_generate_v4(),
  company_id       text                   not null,
  user_id          text                   not null,
  display_name     text,
  is_owner         boolean                not null default false,
  financial_access financial_access_level not null default 'none',
  created_at       timestamptz            not null default now(),
  updated_at       timestamptz            not null default now(),
  unique (company_id, user_id)
);

create index idx_company_members_company on company_members (company_id);
create index idx_company_members_user    on company_members (user_id);

create trigger trg_company_members_updated
  before update on company_members
  for each row execute function update_updated_at();

create table audit_log (
  id           uuid        primary key default uuid_generate_v4(),
  company_id   text        not null,
  actor_id     text        not null,
  action       text        not null,
  entity_type  text        not null,
  entity_id    text        not null,
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index idx_audit_log_company on audit_log (company_id, created_at desc);
create index idx_audit_log_actor   on audit_log (company_id, actor_id);
create index idx_audit_log_entity  on audit_log (entity_type, entity_id);

-- Immutability: block UPDATE and DELETE on audit_log at the DB level
create or replace function prevent_audit_log_modification()
returns trigger language plpgsql
set search_path = public
as $$
begin
  raise exception
    'audit_log is immutable: UPDATE and DELETE are not permitted (row id: %)', old.id;
end;
$$;

create trigger trg_audit_log_immutable
  before update or delete on audit_log
  for each row execute function prevent_audit_log_modification();


-- ============================================================
-- PROACTIVE AGENTS SCHEMA (triggers + governance)
-- ============================================================
-- See supabase/migrations/038_proactive_agents.sql for the migration
-- that adds these to an existing database, and the Proactive Agents
-- spec in founders-os-docs/proactive-agents/.

-- ── Triggers (declarative watches) ───────────────────────────
create table triggers (
  id                 uuid        primary key default uuid_generate_v4(),
  company_id         text        not null default 'default',
  scope              text        not null default 'org'
                                   check (scope in ('org', 'personal')),
  owner_id           text,
  name               text        not null,
  description        text,
  condition_source   text        not null default 'data'
                                   check (condition_source in ('data', 'connector')),
  condition_type     text        not null
                                   check (condition_type in (
                                     'stalled_deal', 'overspend', 'budget_threshold',
                                     'overdue_task', 'stuck_task', 'feed_keyword_match',
                                     'overdue_invoice')),
  connector          text,
  params             jsonb       not null default '{}',
  action_type        text        not null default 'run_playbook'
                                   check (action_type in ('run_playbook', 'create_task', 'notify')),
  playbook_id        uuid        references playbooks(id) on delete set null,
  action_params      jsonb       not null default '{}',
  cadence_hint       text        not null default 'daily'
                                   check (cadence_hint in ('hourly', 'daily', 'weekly')),
  digest             boolean     not null default false,
  enabled            boolean     not null default true,
  bound_entity_type  text,
  bound_entity_id    uuid,
  last_fired_at      timestamptz,
  last_state         text,
  created_by         text        not null default 'default',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  constraint triggers_id_company_unique unique (id, company_id)
);

create index idx_triggers_company  on triggers (company_id);
create index idx_triggers_enabled  on triggers (company_id) where enabled = true and deleted_at is null;
create index idx_triggers_bound    on triggers (bound_entity_type, bound_entity_id)
                                      where bound_entity_id is not null;
create index idx_triggers_deleted  on triggers (deleted_at) where deleted_at is not null;

create trigger trg_triggers_updated
  before update on triggers
  for each row execute function update_updated_at();

-- ── Guardrail policy (one row per company) ───────────────────
create table guardrail_policy (
  company_id     text        primary key default 'default',
  tier_outcomes  jsonb       not null default '{
                                "read": "allow",
                                "native_create": "allow_with_log",
                                "external_write": "hold_for_approval",
                                "destructive": "hold_for_approval",
                                "exfiltration": "hold_for_approval"
                              }',
  dry_run        boolean     not null default false,
  paused         boolean     not null default false,
  updated_at     timestamptz not null default now()
);

create trigger trg_guardrail_policy_updated
  before update on guardrail_policy
  for each row execute function update_updated_at();

-- ── Pending approvals (held actions + replay guard) ──────────
create table pending_approvals (
  id                uuid        primary key default uuid_generate_v4(),
  company_id        text        not null default 'default',
  jti               text        not null,
  action_type       text        not null,
  action_params     jsonb       not null,
  action_hash       text        not null,
  tier              text        not null
                                  check (tier in ('read','native_create','external_write',
                                                  'destructive','exfiltration')),
  source            text        not null,
  summary           text        not null,
  status            text        not null default 'pending'
                                  check (status in ('pending','approved','rejected','executed','expired')),
  token_expires_at  timestamptz not null,
  approved_by       text,
  approved_at       timestamptz,
  delivery_channel  text,
  delivery_ref      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint pending_approvals_jti_company_unique unique (company_id, jti)
);

create index idx_pending_approvals_open on pending_approvals (company_id)
                                            where status = 'pending';

create trigger trg_pending_approvals_updated
  before update on pending_approvals
  for each row execute function update_updated_at();

-- ── Reconciliation findings (off-book external side effects) ─
create table reconciliation_findings (
  id                uuid        primary key default uuid_generate_v4(),
  company_id        text        not null default 'default',
  connector         text        not null,
  external_ref      text        not null,
  observed_at       timestamptz not null,
  summary           text        not null,
  matched_approval  uuid        references pending_approvals(id),
  status            text        not null default 'ungoverned'
                                  check (status in ('matched','unverified','ungoverned','acknowledged')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint reconciliation_findings_ref_unique unique (company_id, connector, external_ref)
);

create index idx_recon_open on reconciliation_findings (company_id)
                                where status = 'ungoverned';

create trigger trg_recon_updated
  before update on reconciliation_findings
  for each row execute function update_updated_at();

-- ── Trigger fires inbox (migration 039) ──────────────────────
-- Durable worklist of data-condition fires for the detect tick to write
-- and the next session to drain. One live row per trigger; a worsening
-- re-fire upserts onto it.

create table trigger_fires (
  id              uuid        primary key default uuid_generate_v4(),
  company_id      text        not null default 'default',
  trigger_id      uuid        not null references triggers(id) on delete cascade,
  condition_type  text        not null,
  brief           text        not null,
  fingerprint     text        not null,
  action          jsonb       not null default '{}',
  status          text        not null default 'pending'
                                check (status in ('pending', 'acted', 'dismissed')),
  acted_at        timestamptz,
  acted_by        text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint trigger_fires_one_per_trigger unique (company_id, trigger_id)
);

create index idx_trigger_fires_open    on trigger_fires (company_id) where status = 'pending';
create index idx_trigger_fires_trigger on trigger_fires (trigger_id);

create trigger trg_trigger_fires_updated
  before update on trigger_fires
  for each row execute function update_updated_at();


-- ── Notifications inbox (migration 040) ──────────────────────
-- Lightweight, free-form heads-up surface the headless agent (and any
-- other source) posts to via notify_inbox. Distinct from trigger_fires:
-- not FK-bound to a trigger, append-only, holds arbitrary notes rather
-- than one-row-per-trigger fires.

create table notifications (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  title       text        not null,
  body        text,
  level       text        not null default 'info' check (level in ('info', 'warning')),
  source      text,
  created_by  text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index idx_notifications_unread on notifications (company_id) where read_at is null;


-- ============================================================
-- RSS SCHEMA
-- ============================================================

-- ── Feed Catalog (shared, company-level) ─────────────────────

create table feed_catalog (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  url         text        not null,
  title       text        not null,
  description text,
  site_url    text,
  icon_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint feed_catalog_id_company_unique unique (id, company_id)
);

create unique index idx_feed_catalog_company_url on feed_catalog (company_id, url);
create index        idx_feed_catalog_company     on feed_catalog (company_id);

create trigger trg_feed_catalog_updated
  before update on feed_catalog
  for each row execute function update_updated_at();

-- ── Feeds (per-user subscriptions) ───────────────────────────

create table feeds (
  id                   uuid        primary key default uuid_generate_v4(),
  catalog_id           uuid        not null references feed_catalog(id) on delete cascade,
  company_id           text        not null default 'default',
  user_id              text        not null default 'default',
  tags                 text[]      not null default '{}',
  pinned               boolean     not null default false,
  refresh_interval_min int         not null default 60,
  last_fetched_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint feeds_id_company_unique unique (id, company_id)
);

create unique index idx_feeds_user_catalog on feeds (company_id, user_id, catalog_id);
create index        idx_feeds_catalog_id   on feeds (catalog_id);
create index        idx_feeds_tenant       on feeds (company_id, user_id);
create index        idx_feeds_pinned       on feeds (company_id, user_id) where pinned = true;
create index        idx_feeds_tags         on feeds using gin (tags);

create trigger trg_feeds_updated
  before update on feeds
  for each row execute function update_updated_at();

-- ── Feed Bookmarks (saved items) ─────────────────────────────

create table feed_bookmarks (
  id           uuid        primary key default uuid_generate_v4(),
  feed_id      uuid        references feeds(id) on delete set null,
  catalog_id   uuid        references feed_catalog(id) on delete set null,
  company_id   text        not null default 'default',
  user_id      text        not null default 'default',
  guid         text        not null,
  title        text        not null,
  link         text,
  summary      text,
  content      text,
  author       text,
  published_at timestamptz,
  feed_title   text,
  feed_url     text,
  created_at   timestamptz not null default now()
);

create unique index idx_feed_bookmarks_user_guid  on feed_bookmarks (company_id, user_id, guid);
create index        idx_feed_bookmarks_tenant     on feed_bookmarks (company_id, user_id);
create index        idx_feed_bookmarks_feed_id    on feed_bookmarks (feed_id);
create index        idx_feed_bookmarks_catalog_id on feed_bookmarks (catalog_id);


-- ============================================================
-- MAINTENANCE JOBS
-- ============================================================

-- ── Purge function ──────────────────────────────────────────
-- Hard-deletes soft-deleted rows older than 30 days.
-- Scheduled via pg_cron daily at 3 AM UTC.

create or replace function purge_soft_deleted_rows()
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cutoff timestamptz := now() - interval '30 days';
  counts jsonb := '{}'::jsonb;
  n int;
begin
  delete from financial_transactions where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('financial_transactions', n); end if;

  delete from financial_accounts where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('financial_accounts', n); end if;

  delete from financial_categories where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('financial_categories', n); end if;

  -- Interactions individually soft-deleted (before customers so the
  -- cascade from a customer purge doesn't double-count them).
  delete from interactions where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('interactions', n); end if;

  delete from customers where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('customers', n); end if;

  delete from contacts where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('contacts', n); end if;

  delete from tasks where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('tasks', n); end if;

  delete from tag_registry where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('tag_registry', n); end if;

  delete from playbooks where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('playbooks', n); end if;

  delete from playbook_steps where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('playbook_steps', n); end if;

  delete from projects where deleted_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('projects', n); end if;

  return counts;
end;
$$;

-- ── Demo reaper ─────────────────────────────────────────────
-- Removes data left behind by abandoned demo runs (per-run
-- "demorun-" tags). Scheduled via pg_cron hourly.

create or replace function reap_stale_demo_runs(stale_after interval default '06:00:00'::interval)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cutoff     timestamptz := now() - stale_after;
  stale_tags text[];
  run_ids    text[];
  counts     jsonb := '{}'::jsonb;
  n          int;
begin
  -- Reserved demo-run namespace, old enough to be a finished or
  -- abandoned run. tag name == slug for demorun- tags.
  select array_agg(name) into stale_tags
  from tag_registry
  where slug like 'demorun-%'
    and created_at < cutoff;

  -- Nothing old enough to reap.
  if stale_tags is null then
    return jsonb_build_object('stale_runs', 0);
  end if;

  counts := counts || jsonb_build_object('stale_runs', array_length(stale_tags, 1));

  -- The 8-char base36 run_id trailing each stale run tag
  -- (demorun-<demokey>-<run_id>). The demo stamps this same run_id on
  -- every vocabulary tag it registers, whose slugs look like
  -- "fundraising-<run_id>" and carry no demorun- prefix.
  select array_agg(distinct rid) into run_ids
  from (
    select substring(slug from '-([a-z0-9]{8})$') as rid
    from tag_registry
    where slug like 'demorun-%'
      and created_at < cutoff
  ) s
  where rid is not null;

  -- Customers carrying a stale run tag (cascades to contacts and interactions).
  delete from customers where tags && stale_tags;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('customers', n); end if;

  -- Tasks carrying a stale run tag.
  delete from tasks where tags && stale_tags;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('tasks', n); end if;

  -- Demo memories are stamped with project = run tag. Gate on the
  -- memory's own created_at so a fresh concurrent run is never touched.
  delete from memories where project like 'demorun-%' and created_at < cutoff;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('memories', n); end if;

  -- Bookmarks belonging to this run's feeds. feed_bookmarks.feed_id is
  -- ON DELETE SET NULL, so remove these before the feeds or they orphan.
  delete from feed_bookmarks
  where feed_id in (select id from feeds where tags && stale_tags);
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('feed_bookmarks', n); end if;

  -- Feed subscriptions this run created (carry a stale run tag).
  delete from feeds where tags && stale_tags;
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('feeds', n); end if;

  -- Tag-registry rows. Two kinds, both gated to stale runs:
  --   * the run tags themselves (demorun-...), and
  --   * the per-run vocabulary the demo registered (seed + auto-registered
  --     tags), which are NOT demorun-prefixed but end with the run's run_id.
  delete from tag_registry
  where created_at < cutoff
    and (
      slug like 'demorun-%'
      or (run_ids is not null and exists (
        select 1 from unnest(run_ids) as rid
        where tag_registry.slug like '%-' || rid
      ))
    );
  get diagnostics n = row_count;
  if n > 0 then counts := counts || jsonb_build_object('tags', n); end if;

  return counts;
end;
$$;

-- Schedule maintenance jobs via pg_cron (if available)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'purge-soft-deleted-rows',
      '0 3 * * *',
      'SELECT purge_soft_deleted_rows()'
    );
    perform cron.schedule(
      'reap-stale-demo-runs',
      '0 * * * *',
      'SELECT reap_stale_demo_runs()'
    );
  end if;
end;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- The MCP server connects via the Supabase service role key,
-- which bypasses RLS entirely. All tables use deny-all policies
-- for authenticated (non-service-role) clients as a defense-in-depth
-- measure. When a second client type (dashboard, mobile app) is
-- built, add scoped policies in a new migration rather than
-- loosening these.

-- CRM
alter table customers      enable row level security;
alter table contacts       enable row level security;
alter table interactions   enable row level security;
alter table tasks          enable row level security;
alter table task_links     enable row level security;
alter table task_notes     enable row level security;
alter table tag_registry   enable row level security;
alter table playbooks      enable row level security;
alter table playbook_steps enable row level security;
alter table playbook_runs  enable row level security;
alter table projects       enable row level security;

-- Memory
alter table memories enable row level security;

-- Financial
alter table financial_categories   enable row level security;
alter table financial_accounts     enable row level security;
alter table financial_transactions enable row level security;
alter table company_members        enable row level security;
alter table audit_log              enable row level security;

-- RSS
alter table feed_catalog   enable row level security;
alter table feeds          enable row level security;
alter table feed_bookmarks enable row level security;

-- Proactive Agents (triggers + governance)
alter table triggers                enable row level security;
alter table guardrail_policy        enable row level security;
alter table pending_approvals       enable row level security;
alter table reconciliation_findings enable row level security;
alter table trigger_fires           enable row level security;
alter table notifications           enable row level security;

-- Deny-all for authenticated role on every table
create policy "deny authenticated - customers"
  on customers for all to authenticated using (false) with check (false);
create policy "deny authenticated - contacts"
  on contacts for all to authenticated using (false) with check (false);
create policy "deny authenticated - interactions"
  on interactions for all to authenticated using (false) with check (false);
create policy "deny authenticated - tasks"
  on tasks for all to authenticated using (false) with check (false);
create policy "deny authenticated - task_links"
  on task_links for all to authenticated using (false) with check (false);
create policy "deny authenticated - task_notes"
  on task_notes for all to authenticated using (false) with check (false);
create policy "deny authenticated - tag_registry"
  on tag_registry for all to authenticated using (false) with check (false);
create policy "deny authenticated - playbooks"
  on playbooks for all to authenticated using (false) with check (false);
create policy "deny authenticated - playbook_steps"
  on playbook_steps for all to authenticated using (false) with check (false);
create policy "deny authenticated - playbook_runs"
  on playbook_runs for all to authenticated using (false) with check (false);
create policy "deny authenticated - projects"
  on projects for all to authenticated using (false) with check (false);
create policy "deny authenticated - memories"
  on memories for all to authenticated using (false) with check (false);
create policy "deny authenticated - financial_categories"
  on financial_categories for all to authenticated using (false) with check (false);
create policy "deny authenticated - financial_accounts"
  on financial_accounts for all to authenticated using (false) with check (false);
create policy "deny authenticated - financial_transactions"
  on financial_transactions for all to authenticated using (false) with check (false);
create policy "deny authenticated - company_members"
  on company_members for all to authenticated using (false) with check (false);
create policy "deny authenticated - audit_log insert"
  on audit_log for insert to authenticated with check (false);
create policy "deny authenticated - audit_log select"
  on audit_log for select to authenticated using (false);
create policy "deny authenticated - feed_catalog"
  on feed_catalog for all to authenticated using (false) with check (false);
create policy "deny authenticated - feeds"
  on feeds for all to authenticated using (false) with check (false);
create policy "deny authenticated - feed_bookmarks"
  on feed_bookmarks for all to authenticated using (false) with check (false);
create policy "deny authenticated - triggers"
  on triggers for all to authenticated using (false) with check (false);
create policy "deny authenticated - guardrail_policy"
  on guardrail_policy for all to authenticated using (false) with check (false);
create policy "deny authenticated - pending_approvals"
  on pending_approvals for all to authenticated using (false) with check (false);
create policy "deny authenticated - reconciliation_findings"
  on reconciliation_findings for all to authenticated using (false) with check (false);
create policy "deny authenticated - trigger_fires"
  on trigger_fires for all to authenticated using (false) with check (false);
create policy "deny authenticated - notifications"
  on notifications for all to authenticated using (false) with check (false);

-- ============================================================
-- RLS AUTO-ENABLE (safety net)
-- ============================================================
-- Event trigger that enables row level security on any table
-- created in the public schema, so a future migration that
-- forgets "enable row level security" can't silently expose a
-- table through Supabase's auto-generated APIs.
-- Requires the postgres role (Supabase SQL Editor) or superuser;
-- skipped with a notice if the current role can't create it.

create or replace function rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name is not null
       and cmd.schema_name in ('public')
       and cmd.schema_name not in ('pg_catalog', 'information_schema')
       and cmd.schema_name not like 'pg_toast%'
       and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
    else
      raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
    end if;
  end loop;
end;
$$;

-- Lock execution down to the owner (postgres) only.
revoke execute on function rls_auto_enable() from public;

do $$
begin
  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls
      on ddl_command_end
      execute function rls_auto_enable();
  end if;
exception
  when insufficient_privilege then
    raise notice 'ensure_rls event trigger not created (requires the postgres role or superuser); RLS is still enabled explicitly on all tables above.';
end;
$$;

-- ============================================================
-- DATA API GRANTS
-- ============================================================
-- Required for Supabase projects created on or after 2026-05-30,
-- which no longer receive automatic Data API privileges on new
-- tables (https://github.com/orgs/supabase/discussions/45329).
-- Without these, the MCP server's supabase-js client cannot see
-- the tables created above. RLS (deny-all for authenticated)
-- still gates the authenticated role; service_role bypasses RLS.

-- Base tables (20)
grant select, insert, update, delete on public.audit_log              to service_role, authenticated;
grant select, insert, update, delete on public.company_members        to service_role, authenticated;
grant select, insert, update, delete on public.contacts               to service_role, authenticated;
grant select, insert, update, delete on public.customers              to service_role, authenticated;
grant select, insert, update, delete on public.feed_bookmarks         to service_role, authenticated;
grant select, insert, update, delete on public.feed_catalog           to service_role, authenticated;
grant select, insert, update, delete on public.feeds                  to service_role, authenticated;
grant select, insert, update, delete on public.financial_accounts     to service_role, authenticated;
grant select, insert, update, delete on public.financial_categories   to service_role, authenticated;
grant select, insert, update, delete on public.financial_transactions to service_role, authenticated;
grant select, insert, update, delete on public.interactions           to service_role, authenticated;
grant select, insert, update, delete on public.memories               to service_role, authenticated;
grant select, insert, update, delete on public.playbook_runs          to service_role, authenticated;
grant select, insert, update, delete on public.playbook_steps         to service_role, authenticated;
grant select, insert, update, delete on public.playbooks              to service_role, authenticated;
grant select, insert, update, delete on public.projects               to service_role, authenticated;
grant select, insert, update, delete on public.tag_registry           to service_role, authenticated;
grant select, insert, update, delete on public.task_links             to service_role, authenticated;
grant select, insert, update, delete on public.task_notes             to service_role, authenticated;
grant select, insert, update, delete on public.tasks                  to service_role, authenticated;
grant select, insert, update, delete on public.triggers               to service_role, authenticated;
grant select, insert, update, delete on public.guardrail_policy       to service_role, authenticated;
grant select, insert, update, delete on public.pending_approvals      to service_role, authenticated;
grant select, insert, update, delete on public.reconciliation_findings to service_role, authenticated;
grant select, insert, update, delete on public.trigger_fires          to service_role, authenticated;
grant select, insert, update, delete on public.notifications          to service_role, authenticated;

-- Views (3)
grant select on public.customer_summary                 to service_role, authenticated;
grant select on public.financial_pl_summary             to service_role, authenticated;
grant select on public.financial_pl_by_customer_summary to service_role, authenticated;

-- Sequences
grant usage, select on all sequences in schema public to service_role, authenticated;

-- Function execute grants
grant execute on function create_financial_transaction(
  text, date, text, numeric, uuid, uuid, uuid, boolean, uuid
) to anon, authenticated, service_role;

-- ============================================================
-- SCHEMA VERSION MARKER
-- ============================================================
-- Records which schema state this database carries. The server's
-- get_version tool compares this against the version it expects
-- and reports any migration files you still need to run after an
-- update. Every migration in supabase/migrations/ bumps it.
--
-- This section is intentionally idempotent (unlike the rest of
-- this file) so it can be run on its own to backfill a database
-- that was created before the marker existed.

create table if not exists founders_os_meta (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

alter table founders_os_meta enable row level security;

do $$
begin
  create policy "deny authenticated - founders_os_meta"
    on founders_os_meta for all to authenticated using (false) with check (false);
exception
  when duplicate_object then null;
end;
$$;

grant select, insert, update, delete on public.founders_os_meta to service_role, authenticated;

-- 40 = adds the notifications inbox (migration 040). Keep in lockstep
-- with EXPECTED_SCHEMA_VERSION in packages/core/src/schema-version.ts
-- (schema-version-lint.test.ts enforces this).
insert into founders_os_meta (key, value)
  values ('schema_version', '40')
  on conflict (key) do nothing;

-- ============================================================
-- RELOAD POSTGREST SCHEMA CACHE
-- ============================================================

notify pgrst, 'reload schema';
