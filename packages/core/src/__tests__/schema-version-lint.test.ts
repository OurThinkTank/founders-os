// ============================================================
// Founders OS - Schema version lockstep lint
// ============================================================
// The database carries a schema_version marker (founders_os_meta,
// written by setup.sql, bumped by each migration). The server
// carries EXPECTED_SCHEMA_VERSION (schema-version.ts). get_version
// compares the two and tells self-hosted users which migration
// files they still need to run.
//
// That only works if the constant and the marker setup.sql writes
// never drift apart. This lint pins them together: a schema change
// must bump both in the same PR (and ship a migration that bumps
// the marker on existing databases).
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_SCHEMA_VERSION } from "../schema-version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUPABASE_DIR = resolve(__dirname, "..", "..", "..", "..", "supabase");
const SETUP_SQL = readFileSync(resolve(SUPABASE_DIR, "setup.sql"), "utf-8");

describe("schema version lockstep", () => {
  it("setup.sql writes the schema_version marker EXPECTED_SCHEMA_VERSION names", () => {
    const m = SETUP_SQL.match(
      /values\s*\(\s*'schema_version'\s*,\s*'(\d+)'\s*\)/i
    );
    expect(
      m,
      "Could not find the schema_version insert in setup.sql's SCHEMA VERSION MARKER section."
    ).not.toBeNull();
    expect(Number.parseInt(m![1], 10)).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it("the marker insert is idempotent (on conflict do nothing)", () => {
    // The marker section doubles as the backfill snippet for databases
    // created before the marker existed, so re-running it must be safe.
    const idx = SETUP_SQL.indexOf("'schema_version'");
    const region = SETUP_SQL.slice(idx, idx + 300);
    expect(region).toMatch(/on\s+conflict\s*\(\s*key\s*\)\s*do\s+nothing/i);
  });

  it("the newest migration file (if any) bumps the marker to EXPECTED_SCHEMA_VERSION", () => {
    const migrationsDir = resolve(SUPABASE_DIR, "migrations");
    if (!existsSync(migrationsDir)) return;
    const sqlFiles = readdirSync(migrationsDir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .sort();
    if (sqlFiles.length === 0) {
      // Empty at launch: setup.sql alone defines the version. Covered above.
      return;
    }
    const newest = sqlFiles[sqlFiles.length - 1];
    const newestNumber = Number.parseInt(newest.slice(0, 3), 10);
    expect(
      newestNumber,
      `Newest migration ${newest} should match EXPECTED_SCHEMA_VERSION ` +
        `(${EXPECTED_SCHEMA_VERSION}); bump the constant in schema-version.ts ` +
        `and the setup.sql marker in the same PR.`
    ).toBe(EXPECTED_SCHEMA_VERSION);
    const source = readFileSync(resolve(migrationsDir, newest), "utf-8");
    expect(
      /update\s+founders_os_meta/i.test(source) &&
        source.includes(`'${newestNumber}'`),
      `${newest} must bump the schema_version marker: ` +
        `update founders_os_meta set value = '${newestNumber}', ` +
        `updated_at = now() where key = 'schema_version';`
    ).toBe(true);
  });
});
