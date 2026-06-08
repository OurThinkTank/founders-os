// ============================================================
// Founders OS - Migration Grants Lint
// ============================================================
// Ratchet test that enforces the explicit-grants convention
// introduced in migration 035 (see docs/data-api-grants-migration.md).
//
// Why this exists:
//
//   Supabase is removing automatic Data API exposure for new
//   public tables. Migrations created from 2026-05-30 onward
//   that run against a fresh Supabase project will produce
//   tables the @supabase/supabase-js client cannot see unless
//   the migration includes an explicit GRANT statement.
//
//   Migration 035 added the catchup grants for the 20 base
//   tables and 3 views that existed at the time. Every NEW
//   migration must include grants alongside any CREATE TABLE
//   or CREATE VIEW it adds in `public`.
//
// What this enforces:
//
//   For every migration file whose leading 3-digit number is
//   >= MIGRATION_CUTOFF, the lint scans for `CREATE TABLE
//   public.<x>` and `CREATE VIEW public.<x>` statements and
//   asserts that a `GRANT ... ON public.<x> ... TO service_role`
//   exists somewhere in the same file.
//
//   Files with number < MIGRATION_CUTOFF, or with non-standard
//   names (no 3-digit prefix), are exempt. The convention started
//   with 035; 036+ is enforced. This is the same ratchet pattern
//   used by tool-context-lint.test.ts.
//
// What this does NOT enforce:
//
//   - The exact set of roles granted. We require service_role
//     because that is the role the MCP server uses today; it is
//     the catastrophic-failure case if missed. authenticated and
//     anon are convention but not blocked by this lint.
//   - GRANT statements on sequences, functions, or other object
//     types. Add explicit checks if the codebase later runs into
//     drift in those areas.
//
// If you genuinely need to ship a migration without a CREATE-then-
// GRANT pairing (e.g., a migration that only alters existing tables,
// which is the common case), this lint will pass: it triggers only
// on CREATE statements. If you need an exception for a CREATE
// without a matching GRANT, append `-- lint: migration-grants
// allow-no-grant <reason>` on the CREATE line.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// supabase/migrations is at packages/mcp-server/src/__tests__/../../../supabase/migrations
const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "..", "..", "supabase", "migrations");

/**
 * First migration number that is required to follow the
 * inline-GRANT convention. Migration 035 added the catchup grants
 * for the existing 20 tables, so the convention starts at 036.
 */
const MIGRATION_CUTOFF = 36;

const EXCEPTION_MARKER = "lint: migration-grants allow-no-grant";

type CreateMatch = {
  kind: "TABLE" | "VIEW";
  schemaQualifiedName: string;
  unqualifiedName: string;
  lineNumber: number;
  rawLine: string;
};

/**
 * Pull out every CREATE TABLE / CREATE VIEW (and OR REPLACE
 * variants) that targets the `public` schema from a SQL file.
 *
 * Matching is case-insensitive and tolerates the common variants:
 *   CREATE TABLE public.foo
 *   CREATE TABLE IF NOT EXISTS public.foo
 *   CREATE VIEW public.foo
 *   CREATE OR REPLACE VIEW public.foo
 *   CREATE MATERIALIZED VIEW public.foo
 *
 * Unqualified CREATE TABLE foo (without `public.`) is not flagged.
 * Convention is to qualify every relation explicitly; the existing
 * codebase already does this and the lint nudges new code to keep
 * doing it.
 */
function findCreatesInPublic(source: string): CreateMatch[] {
  const matches: CreateMatch[] = [];
  const lines = source.split("\n");

  const tableRe = /\bcreate\s+(?:table)\s+(?:if\s+not\s+exists\s+)?public\.([a-zA-Z_][a-zA-Z0-9_]*)/i;
  const viewRe = /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?public\.([a-zA-Z_][a-zA-Z0-9_]*)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(EXCEPTION_MARKER)) continue;

    const tableMatch = line.match(tableRe);
    if (tableMatch) {
      matches.push({
        kind: "TABLE",
        schemaQualifiedName: `public.${tableMatch[1]}`,
        unqualifiedName: tableMatch[1],
        lineNumber: i + 1,
        rawLine: line.trim(),
      });
      continue;
    }
    const viewMatch = line.match(viewRe);
    if (viewMatch) {
      matches.push({
        kind: "VIEW",
        schemaQualifiedName: `public.${viewMatch[1]}`,
        unqualifiedName: viewMatch[1],
        lineNumber: i + 1,
        rawLine: line.trim(),
      });
    }
  }

  return matches;
}

/**
 * Does the file contain a GRANT ... ON public.<name> ... TO ...
 * service_role ... ? Matching is loose: any line that mentions
 * GRANT, the qualified relation name, and service_role counts.
 *
 * This avoids over-fitting to one specific spelling and allows the
 * standard block form (single line with both `service_role` and
 * `authenticated`) as well as one-role-per-line variants.
 */
function fileGrantsServiceRoleOn(
  source: string,
  schemaQualifiedName: string,
  unqualifiedName: string
): boolean {
  const lines = source.split("\n");
  for (const raw of lines) {
    const lower = raw.toLowerCase();
    if (!lower.includes("grant")) continue;
    if (!lower.includes("service_role")) continue;
    // The grant may name the relation as `public.foo` or as just `foo`
    // when the migration is inside a `SET search_path` block. Accept
    // either spelling.
    if (
      lower.includes(schemaQualifiedName.toLowerCase()) ||
      new RegExp(`\\b${unqualifiedName.toLowerCase()}\\b`).test(lower)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the migration number from a filename like
 * `036_my_change.sql`. Returns null when the filename does not
 * start with three digits followed by an underscore.
 */
function migrationNumber(filename: string): number | null {
  const m = filename.match(/^(\d{3})_/);
  return m ? parseInt(m[1], 10) : null;
}

describe("Migration grants lint - new migrations must grant on CREATE", () => {
  const allFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const inScope = allFiles.filter((f) => {
    const n = migrationNumber(f);
    return n !== null && n >= MIGRATION_CUTOFF;
  });

  if (inScope.length === 0) {
    // No migrations at or above the cutoff yet. This is the steady
    // state until the next schema change ships. Emit an informational
    // test so the lint is visible in test output.
    it(`no migrations at or above #${MIGRATION_CUTOFF} yet (lint will activate on next new migration)`, () => {
      expect(inScope.length).toBe(0);
    });
    return;
  }

  for (const filename of inScope) {
    it(`${filename}: every CREATE TABLE/VIEW in public has a matching GRANT to service_role`, () => {
      const source = readFileSync(resolve(MIGRATIONS_DIR, filename), "utf-8");
      const creates = findCreatesInPublic(source);

      if (creates.length === 0) {
        // Common case: a migration that only ALTERs existing tables.
        // Nothing to enforce.
        return;
      }

      const violations: string[] = [];
      for (const c of creates) {
        if (!fileGrantsServiceRoleOn(source, c.schemaQualifiedName, c.unqualifiedName)) {
          violations.push(
            `  Line ${c.lineNumber} (${c.kind}): ${c.schemaQualifiedName}\n` +
              `    ${c.rawLine}`
          );
        }
      }

      expect(
        violations,
        `${filename} creates relations in public without a matching GRANT to service_role:\n` +
          violations.join("\n") +
          `\n\nAdd a block like:\n` +
          `  GRANT SELECT, INSERT, UPDATE, DELETE ON public.<name>\n` +
          `    TO service_role, authenticated;\n\n` +
          `If this CREATE genuinely needs no grant (extremely rare), ` +
          `append '-- ${EXCEPTION_MARKER} <reason>' to the CREATE line.`
      ).toHaveLength(0);
    });
  }
});
