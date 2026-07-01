-- ============================================================
-- Founders OS — Migration 040: Notifications inbox
-- ============================================================
-- Adds the notifications table: a lightweight, free-form heads-up
-- surface the headless agent (and any other source) can post to, so
-- the next interactive session sees "you should know this" notes that
-- do not belong on the task list.
--
-- Why a new table rather than trigger_fires: the trigger_fires inbox
-- (migration 039) is FK-bound to a trigger_id with one live row per
-- trigger, so it holds trigger fires, not arbitrary notes. notify_inbox
-- needs its own append-only surface for pure notifications.
--
-- This is the home for the autonomous runner's `notify_inbox` action:
-- a native write that classifies native_create (allow_with_log), so it
-- needs no confirm_token and is autonomous-safe. created_by carries the
-- principal (autonomous-run:<runId> for the unattended agent).
--
-- Conventions (see supabase/migrations/README.md):
--   * Idempotent: create table if not exists, guarded policy creation.
--   * Explicit GRANT ... to service_role, authenticated (grants lint).
--   * RLS enabled with a deny-all policy for the authenticated role;
--     the service role bypasses RLS.
--   * Bumps the schema_version marker to 40; keep in lockstep with
--     EXPECTED_SCHEMA_VERSION (schema-version.ts) and setup.sql.
--
-- Apply on existing databases AFTER updating the connector. Fresh
-- installs get the same schema from setup.sql.
-- ============================================================

-- ── notifications ──────────────────────────────────────────
create table if not exists public.notifications (
  id          uuid        primary key default uuid_generate_v4(),
  company_id  text        not null default 'default',
  title       text        not null,
  body        text,
  level       text        not null default 'info' check (level in ('info', 'warning')),
  source      text,                 -- 'autonomous-run:<runId>', 'trigger:<id>', 'agent', ...
  created_by  text,
  read_at     timestamptz,          -- null = unread
  created_at  timestamptz not null default now()
);

-- Unread lookups (the session-briefing read) are the hot path.
create index if not exists idx_notifications_unread on notifications (company_id)
                                        where read_at is null;

-- ── Row Level Security (deny-all for authenticated; service role bypasses) ──
alter table notifications enable row level security;

do $$
begin
  create policy "deny authenticated - notifications"
    on notifications for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

-- ── Data API grants (required for Supabase projects created 2026-05-30+) ──
grant select, insert, update, delete on public.notifications to service_role, authenticated;

-- ── Schema version bump ────────────────────────────────────
update founders_os_meta
  set value = '40', updated_at = now()
  where key = 'schema_version';

-- ── Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
