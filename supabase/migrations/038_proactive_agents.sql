-- ============================================================
-- Founders OS — Migration 038: Proactive Agents (Triggers + Governance)
-- ============================================================
-- Adds the data model for the Proactive Agents feature:
--   triggers                 — declarative watches (data + connector sources)
--   guardrail_policy          — one row per company; tier->outcome + dry_run + pause
--   pending_approvals         — backing record for a held action + replay guard
--   reconciliation_findings   — off-book external side effects flagged by reconcile
--
-- (The spec calls this "five tables"; it counts the reused audit_log,
-- which is unchanged here — only new `action` values are written to it.)
--
-- Conventions (see supabase/migrations/README.md):
--   * Idempotent: create table if not exists, guarded policy/trigger
--     creation, on conflict do nothing. "Run it again" is always safe.
--   * Every new public table gets an explicit GRANT ... to service_role,
--     authenticated (Data API grants lint enforces this).
--   * RLS enabled with a deny-all policy for the authenticated role,
--     mirroring sibling tables; the service role bypasses RLS.
--   * Bumps the schema_version marker to 38; keep in lockstep with
--     EXPECTED_SCHEMA_VERSION (schema-version.ts) and setup.sql.
--
-- Apply on existing databases AFTER updating the connector. Fresh
-- installs get the same schema from setup.sql.
-- ============================================================

-- ── triggers ───────────────────────────────────────────────
create table if not exists public.triggers (
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

create index if not exists idx_triggers_company  on triggers (company_id);
create index if not exists idx_triggers_enabled  on triggers (company_id) where enabled = true and deleted_at is null;
create index if not exists idx_triggers_bound    on triggers (bound_entity_type, bound_entity_id)
                                      where bound_entity_id is not null;
create index if not exists idx_triggers_deleted  on triggers (deleted_at) where deleted_at is not null;

drop trigger if exists trg_triggers_updated on triggers;
create trigger trg_triggers_updated
  before update on triggers
  for each row execute function update_updated_at();

-- ── guardrail_policy ───────────────────────────────────────
create table if not exists public.guardrail_policy (
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

drop trigger if exists trg_guardrail_policy_updated on guardrail_policy;
create trigger trg_guardrail_policy_updated
  before update on guardrail_policy
  for each row execute function update_updated_at();

-- ── pending_approvals ──────────────────────────────────────
create table if not exists public.pending_approvals (
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

create index if not exists idx_pending_approvals_open on pending_approvals (company_id)
                                            where status = 'pending';

drop trigger if exists trg_pending_approvals_updated on pending_approvals;
create trigger trg_pending_approvals_updated
  before update on pending_approvals
  for each row execute function update_updated_at();

-- ── reconciliation_findings ────────────────────────────────
create table if not exists public.reconciliation_findings (
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

create index if not exists idx_recon_open on reconciliation_findings (company_id)
                                where status = 'ungoverned';

drop trigger if exists trg_recon_updated on reconciliation_findings;
create trigger trg_recon_updated
  before update on reconciliation_findings
  for each row execute function update_updated_at();

-- ── Row Level Security (deny-all for authenticated; service role bypasses) ──
alter table triggers                enable row level security;
alter table guardrail_policy        enable row level security;
alter table pending_approvals       enable row level security;
alter table reconciliation_findings enable row level security;

do $$
begin
  create policy "deny authenticated - triggers"
    on triggers for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "deny authenticated - guardrail_policy"
    on guardrail_policy for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "deny authenticated - pending_approvals"
    on pending_approvals for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

do $$
begin
  create policy "deny authenticated - reconciliation_findings"
    on reconciliation_findings for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

-- ── Data API grants (required for Supabase projects created 2026-05-30+) ──
grant select, insert, update, delete on public.triggers                to service_role, authenticated;
grant select, insert, update, delete on public.guardrail_policy        to service_role, authenticated;
grant select, insert, update, delete on public.pending_approvals       to service_role, authenticated;
grant select, insert, update, delete on public.reconciliation_findings to service_role, authenticated;

-- ── Schema version bump ────────────────────────────────────
update founders_os_meta
  set value = '38', updated_at = now()
  where key = 'schema_version';

-- ── Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
