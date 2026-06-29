-- ============================================================
-- Founders OS — Migration 039: Trigger Fires Inbox
-- ============================================================
-- Adds the trigger_fires inbox: a durable worklist of data-condition
-- fires for the headless `founders-os-tick detect` scheduler to write
-- and the next interactive session to drain.
--
-- Why this table exists: evaluate_triggers returns fires in its tool
-- response and writes a trigger_fired audit entry, but it does not
-- persist the resolved-action payload as a list. A detect-ahead-of-
-- session tick needs somewhere to leave fires so they are waiting when
-- a session next opens.
--
-- ONE LIVE ROW PER TRIGGER. The unique (company_id, trigger_id) plus an
-- upsert means a worsening re-fire refreshes the existing row back to
-- 'pending' rather than stacking duplicates. Because the writer only
-- upserts when claimFire returned true (a new or worsened state), the
-- inbox inherits the dedup signal-not-noise property for free. The
-- permanent history still lives in audit_log (trigger_fired entries).
--
-- Conventions (see supabase/migrations/README.md):
--   * Idempotent: create table if not exists, guarded policy creation.
--   * Explicit GRANT ... to service_role, authenticated (grants lint).
--   * RLS enabled with a deny-all policy for the authenticated role;
--     the service role bypasses RLS.
--   * Bumps the schema_version marker to 39; keep in lockstep with
--     EXPECTED_SCHEMA_VERSION (schema-version.ts) and setup.sql.
--
-- Apply on existing databases AFTER updating the connector. Fresh
-- installs get the same schema from setup.sql.
-- ============================================================

-- ── trigger_fires ──────────────────────────────────────────
create table if not exists public.trigger_fires (
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
  -- One live row per trigger; a worsening re-fire upserts onto it.
  constraint trigger_fires_one_per_trigger unique (company_id, trigger_id)
);

create index if not exists idx_trigger_fires_open on trigger_fires (company_id)
                                        where status = 'pending';
create index if not exists idx_trigger_fires_trigger on trigger_fires (trigger_id);

drop trigger if exists trg_trigger_fires_updated on trigger_fires;
create trigger trg_trigger_fires_updated
  before update on trigger_fires
  for each row execute function update_updated_at();

-- ── Row Level Security (deny-all for authenticated; service role bypasses) ──
alter table trigger_fires enable row level security;

do $$
begin
  create policy "deny authenticated - trigger_fires"
    on trigger_fires for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

-- ── Data API grants (required for Supabase projects created 2026-05-30+) ──
grant select, insert, update, delete on public.trigger_fires to service_role, authenticated;

-- ── Schema version bump ────────────────────────────────────
update founders_os_meta
  set value = '39', updated_at = now()
  where key = 'schema_version';

-- ── Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
