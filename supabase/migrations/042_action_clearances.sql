-- ============================================================
-- Founders OS — Migration 042: action_clearances (verify-clearance, T0.2)
-- ============================================================
-- The single-use clearance record that turns the headless runtime's
-- canUseTool hook into a real chokepoint (Option B, B-ii). When
-- execute_action clears an EXTERNAL action, it records a clearance here.
-- Before the runtime dispatches the connector call, the hook calls
-- verifyAndConsumeClearance(), which atomically flips the row
-- cleared -> dispatched. A row flips at most once, so one clearance
-- authorizes exactly one send; a replay, a forged jti, a different
-- action_hash (bait-and-switch between clear and send), or a wrong
-- connector all fail to match and are denied.
--
-- Held tiers already have a single-use guard (pending_approvals
-- approved -> executed); this table is the parallel guard for the
-- allow / allow_with_log external path, which writes no approval row.
--
-- Conventions (see supabase/migrations/README.md):
--   * Idempotent: create table if not exists, guarded policy.
--   * RLS deny-all for authenticated; service role bypasses.
--   * Explicit GRANT ... to service_role, authenticated.
--   * Bumps schema_version to 42 in lockstep with schema-version.ts +
--     setup.sql.
-- ============================================================

-- ── action_clearances ──────────────────────────────────────
create table if not exists public.action_clearances (
  company_id    text        not null default 'default',
  jti           text        not null,
  action_hash   text        not null,
  connector     text        not null,
  action_type   text        not null,
  status        text        not null default 'cleared'
                              check (status in ('cleared','dispatched')),
  cleared_at    timestamptz not null default now(),
  dispatched_at timestamptz,
  expires_at    timestamptz not null,
  primary key (company_id, jti)
);

-- The hot path is the atomic consume: match an undispatched clearance by
-- (company, jti, connector, action_hash) and flip it. The primary key
-- (company_id, jti) already serves it; connector + action_hash are
-- verified in the same predicate.
create index if not exists idx_action_clearances_open
  on action_clearances (company_id)
  where status = 'cleared';

alter table action_clearances enable row level security;

do $$
begin
  create policy "deny authenticated - action_clearances"
    on action_clearances for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete on public.action_clearances to service_role, authenticated;

-- ── Schema version bump ────────────────────────────────────
update founders_os_meta
  set value = '42', updated_at = now()
  where key = 'schema_version';

-- ── Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
