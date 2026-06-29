// ============================================================
// Founders OS — Expected database schema version
// ============================================================
// The schema version the running server expects to find in the
// `founders_os_meta` table (key 'schema_version'). setup.sql writes
// this marker on fresh installs; every migration that ships in
// supabase/migrations/ bumps it.
//
// Keep three things in lockstep (schema-version-lint.test.ts pins
// the first two):
//   1. This constant.
//   2. The value inserted by the SCHEMA VERSION MARKER section of
//      supabase/setup.sql.
//   3. The `update founders_os_meta ...` statement in the newest
//      migration file, when one exists.
//
// The number continues the pre-launch internal migration sequence:
// 37 means "consolidated through internal migration 037". The first
// public migration will be 038 and bumps this to 38.
//
// get_version compares this against the database's marker and tells
// self-hosted users exactly which migration files they still need
// to run after updating the connector.
// ============================================================

export const EXPECTED_SCHEMA_VERSION = 38;
