-- ============================================================
-- Founders OS — Migration 041: agent run lock + claim_trigger_fire RPC
-- ============================================================
-- Two pieces for the headless full run (Phase 2b.6):
--
-- 1. agent_run_locks + acquire_agent_run_lock(): a per-company run lock
--    so two overlapping `founders-os-tick run --execute` ticks do not
--    both drive the model over the same backlog. A real pg advisory lock
--    cannot hold "for the run duration" through the Supabase pooler
--    (acquire and release land on different pooled backends), so the lock
--    is implemented at the table level. A TTL lets a crashed run's lock be
--    stolen rather than wedging the scheduler forever.
--
-- 2. claim_trigger_fire(): replaces the fragile interpolated PostgREST
--    `.or(last_state.is.null,last_state.neq.<fp>)` fire-claim
--    (review L1) with a parameterized function using the exact
--    `last_state IS DISTINCT FROM p_fp` semantics. Behaviour is identical
--    to the old conditional UPDATE; the fingerprint is no longer spliced
--    into a filter string.
--
-- Conventions (see supabase/migrations/README.md):
--   * Idempotent: create table if not exists, guarded policy, create or
--     replace function.
--   * Explicit GRANT ... to service_role, authenticated.
--   * RLS deny-all for authenticated; service role bypasses.
--   * Functions pin search_path = public (see DB function search_path note).
--   * Bumps schema_version to 41 in lockstep with schema-version.ts + setup.sql.
-- ============================================================

-- ── agent_run_locks ────────────────────────────────────────
create table if not exists public.agent_run_locks (
  company_id  text        primary key default 'default',
  run_id      text        not null,
  locked_at   timestamptz not null default now()
);

alter table agent_run_locks enable row level security;

do $$
begin
  create policy "deny authenticated - agent_run_locks"
    on agent_run_locks for all to authenticated using (false) with check (false);
exception when duplicate_object then null;
end $$;

grant select, insert, update, delete on public.agent_run_locks to service_role, authenticated;

-- ── acquire_agent_run_lock ─────────────────────────────────
-- Returns true if the caller (p_run_id) holds the company's run lock after
-- the call. Acquires when no lock exists or the existing lock is older than
-- p_ttl_seconds (stale, e.g. a crashed run); returns false when a fresh
-- lock is held by a different run. The INSERT ... ON CONFLICT row lock makes
-- concurrent callers serialize, so exactly one wins.
create or replace function acquire_agent_run_lock(
  p_company_id  text,
  p_run_id      text,
  p_ttl_seconds int default 3600
) returns boolean
set search_path = public
as $$
declare owns boolean;
begin
  insert into agent_run_locks (company_id, run_id, locked_at)
    values (p_company_id, p_run_id, now())
  on conflict (company_id) do update
    set run_id = excluded.run_id, locked_at = now()
    where agent_run_locks.locked_at < now() - make_interval(secs => p_ttl_seconds);

  select exists(
    select 1 from agent_run_locks
    where company_id = p_company_id and run_id = p_run_id
  ) into owns;
  return owns;
end;
$$ language plpgsql;

-- ── claim_trigger_fire ─────────────────────────────────────
-- Atomic conditional claim: move last_state to p_fp only when it differs
-- (IS DISTINCT FROM, including the first-ever null). Bumps last_fired_at
-- only when the condition actually matched. Returns true when this call
-- claimed the fire (a row was updated), false when another tick already
-- stored the same fingerprint.
create or replace function claim_trigger_fire(
  p_company_id text,
  p_trigger_id uuid,
  p_fp         text,
  p_matched    boolean
) returns boolean
set search_path = public
as $$
declare affected int;
begin
  update triggers
    set last_state = p_fp,
        last_fired_at = case when p_matched then now() else last_fired_at end
    where company_id = p_company_id
      and id = p_trigger_id
      and last_state is distinct from p_fp;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$ language plpgsql;

grant execute on function acquire_agent_run_lock(text, text, int) to service_role, authenticated;
grant execute on function claim_trigger_fire(text, uuid, text, boolean) to service_role, authenticated;

-- ── Schema version bump ────────────────────────────────────
update founders_os_meta
  set value = '41', updated_at = now()
  where key = 'schema_version';

-- ── Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
