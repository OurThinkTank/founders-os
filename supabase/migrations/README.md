# Migrations

This directory is currently empty.

Fresh installs run [`../setup.sql`](../setup.sql) (or use the
[setup wizard](https://foundersmcp.com/setup), which serves the same file with
the embedding dimension substituted in). setup.sql is the single consolidated
from-scratch schema: extensions, tables, indexes, functions, views, RLS
policies, maintenance jobs, and Data API grants.

## Adding a schema change

New schema changes ship as numbered migration files here, applied in order on
existing databases:

- Name files `NNN_short_description.sql`. Numbering continues from the
  pre-launch internal history; the next number is `038`.
- Make every migration idempotent (`create table if not exists`,
  `create or replace`, guarded `DO` blocks, `on conflict do nothing`). There is
  no migration runner or tracking table on user databases, so "not sure if I
  ran it? Run it again" must always be safe.
- Bump the schema version marker at the end of the file:

  ```sql
  update founders_os_meta
    set value = 'NNN', updated_at = now()
    where key = 'schema_version';
  ```

  and bump `EXPECTED_SCHEMA_VERSION` in `packages/core/src/schema-version.ts`
  plus the marker insert in `setup.sql` to match. The server's `get_version`
  tool compares the marker against the constant to tell users which migrations
  they still need; `schema-version-lint.test.ts` enforces the lockstep.
- Any `CREATE TABLE public.<x>` or `CREATE VIEW public.<x>` must include an
  explicit `GRANT ... TO service_role` in the same file. Supabase projects
  created on or after 2026-05-30 receive no automatic Data API privileges, and
  the `migration-grants-lint` test in `packages/core` enforces this.
- Pin `search_path` on every function (`set search_path = public`, plus
  `extensions` if the function touches pgvector operators). `CREATE OR REPLACE`
  silently drops an existing pin.
- Apply the same change to `setup.sql` in the same PR so fresh installs and
  migrated installs converge on an identical schema.
