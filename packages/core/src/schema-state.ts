// ============================================================
// Founders OS - Database Schema State
// ============================================================
// Answers one question authoritatively: is the database this
// server is pointed at actually set up, and is it at the schema
// version this server expects?
//
// Why this exists as a shared helper rather than living inside
// get_version: a user whose first instruction is "add Acme as a
// customer" never calls get_version. They hit a bare PostgREST
// "table not found" with no hint that the schema was never
// installed. registerToolMap consults this module so any failure
// against an unprovisioned database carries the setup guidance.
//
// This module NEVER runs DDL. Provisioning is the user's action,
// performed in their own Supabase SQL Editor with a file the
// setup page generates for them. See the runbook section 4a for
// why auto-provisioning was considered and rejected.
// ============================================================

import { EXPECTED_SCHEMA_VERSION } from "./schema-version.js";
import type { ToolContext } from "./types/context.js";

/**
 * PostgREST surfaces a missing table two ways depending on whether the
 * failure came from Postgres directly or from PostgREST's schema cache.
 *   42P01    - undefined_table, raw Postgres
 *   PGRST205 - table not found in the schema cache
 * These are the ONLY codes we treat as "the table is not there".
 */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

/** A core table that exists in every provisioned install. Probed only to
 *  tell a blank database apart from a legacy one that predates the marker. */
const CANARY_TABLE = "customers";

const META_TABLE = "founders_os_meta";

export type SchemaStatus =
  /** Marker matches EXPECTED_SCHEMA_VERSION. Everything is fine. */
  | "current"
  /** Provisioned but older than this server expects. Migrations pending. */
  | "behind"
  /** Newer than this server expects. The connector should be updated. */
  | "ahead"
  /** Provisioned, but predates schema-version tracking. */
  | "untracked"
  /** Nothing is there. A fresh Supabase project that never ran setup.sql. */
  | "missing"
  /** The probe itself failed (offline, bad credentials, permissions). */
  | "unknown";

export interface SchemaState {
  status: SchemaStatus;
  /** Version read from the marker, or null when there is no usable marker. */
  dbVersion: number | null;
  expectedVersion: number;
  /** Plain-language next step, or null when nothing needs doing. */
  guidance: string | null;
  /** Probe error message, present only when status is "unknown". */
  error?: string;
}

/** Statuses where the database is usable and no action is needed. */
function isHealthy(status: SchemaStatus): boolean {
  return status === "current" || status === "ahead";
}

const SETUP_URL = "https://foundersmcp.com/setup";
const DOCS_URL = "https://github.com/OurThinkTank/founders-os#setup";

function buildGuidance(
  status: SchemaStatus,
  dbVersion: number | null
): string | null {
  switch (status) {
    case "missing":
      return (
        `Founders OS is connected to your Supabase project, but the database schema has not been installed yet, so no tools can read or write anything. ` +
        `Open ${SETUP_URL}, generate setup.sql for your embedding dimension, and run it in your Supabase SQL Editor. Then retry.`
      );
    case "untracked":
      return (
        `This database predates schema-version tracking. Run the SCHEMA VERSION MARKER section of supabase/setup.sql in your Supabase SQL Editor ` +
        `(it is idempotent and safe on an existing database), then any migration files in supabase/migrations/ you have not applied yet.`
      );
    case "behind": {
      const from = String((dbVersion ?? 0) + 1).padStart(3, "0");
      const to = String(EXPECTED_SCHEMA_VERSION).padStart(3, "0");
      return (
        `Your database is at schema version ${dbVersion} but this server expects ${EXPECTED_SCHEMA_VERSION}. ` +
        `In your Supabase SQL Editor, run the files in supabase/migrations/ numbered ${from} through ${to}, in order. ` +
        `Migrations are idempotent; re-running one you already applied is safe.`
      );
    }
    case "ahead":
      return (
        `Your database is at schema version ${dbVersion}, newer than this server expects (${EXPECTED_SCHEMA_VERSION}). ` +
        `Update the connector itself; do not change the database.`
      );
    case "current":
    case "unknown":
    default:
      return null;
  }
}

// ── Caching ────────────────────────────────────────────────────────────────
// A healthy result is cached for the process lifetime: a provisioned database
// does not un-provision itself underneath a running server.
//
// An UNHEALTHY result is cached only briefly. This matters: the whole point of
// the guidance is that the user goes and runs setup.sql. If "missing" were
// cached permanently, the server would keep insisting the schema is missing
// for the rest of the session even after they fixed it, and the only remedy
// would be restarting their AI app. The TTL means they fix it, retry, and it
// just works.
const UNHEALTHY_TTL_MS = 30_000;

let cached: SchemaState | null = null;
let cachedAt = 0;

/** Drop the cache. Exported for tests and for a future explicit recheck tool. */
export function resetSchemaStateCache(): void {
  cached = null;
  cachedAt = 0;
}

function cacheIsFresh(): boolean {
  if (!cached) return false;
  if (isHealthy(cached.status)) return true;
  return Date.now() - cachedAt < UNHEALTHY_TTL_MS;
}

/**
 * Classify the database this context points at.
 *
 * Never throws: a probe failure becomes status "unknown", because this runs
 * inside error handling and must not manufacture a second error.
 *
 * Costs one query against founders_os_meta. Only when that table is missing
 * does it spend a second query on the canary table, which is what separates a
 * blank database ("missing") from a legacy install ("untracked"). Those two
 * need opposite advice, so the extra probe is worth it on the one path where
 * something is already wrong.
 */
export async function getSchemaState(
  db: ToolContext["db"]
): Promise<SchemaState> {
  if (cacheIsFresh() && cached) return cached;

  const state = await probe(db);
  cached = state;
  cachedAt = Date.now();
  return state;
}

async function probe(db: ToolContext["db"]): Promise<SchemaState> {
  const base = { expectedVersion: EXPECTED_SCHEMA_VERSION };

  try {
    const { data, error } = await db
      .from(META_TABLE)
      .select("value")
      .eq("key", "schema_version")
      .maybeSingle();

    if (error) {
      if (!MISSING_TABLE_CODES.has(error.code ?? "")) {
        return {
          ...base,
          status: "unknown",
          dbVersion: null,
          guidance: null,
          error: error.message,
        };
      }

      // The marker table is absent. Either nothing was ever installed, or
      // this is an old install from before the marker existed. Probing a
      // core table tells them apart, and they need opposite advice.
      const status = (await canaryExists(db)) ? "untracked" : "missing";
      return {
        ...base,
        status,
        dbVersion: null,
        guidance: buildGuidance(status, null),
      };
    }

    const dbVersion = data ? Number.parseInt(data.value, 10) : NaN;
    if (!data || !Number.isFinite(dbVersion)) {
      // The table exists but carries no usable marker.
      return {
        ...base,
        status: "untracked",
        dbVersion: null,
        guidance: buildGuidance("untracked", null),
      };
    }

    const status: SchemaStatus =
      dbVersion === EXPECTED_SCHEMA_VERSION
        ? "current"
        : dbVersion < EXPECTED_SCHEMA_VERSION
          ? "behind"
          : "ahead";

    return {
      ...base,
      status,
      dbVersion,
      guidance: buildGuidance(status, dbVersion),
    };
  } catch (err) {
    return {
      ...base,
      status: "unknown",
      dbVersion: null,
      guidance: null,
      error: err instanceof Error ? err.message : "Schema check failed",
    };
  }
}

/** True when a core table is present, i.e. the schema was installed at some point. */
async function canaryExists(db: ToolContext["db"]): Promise<boolean> {
  try {
    const { error } = await db
      .from(CANARY_TABLE)
      .select("id", { count: "exact", head: true });
    if (!error) return true;
    // Missing canary means a blank database. Any OTHER error (permissions,
    // network) is not evidence of absence, so we do not claim the database is
    // blank on that basis.
    return !MISSING_TABLE_CODES.has(error.code ?? "");
  } catch {
    return true;
  }
}

/**
 * Setup guidance to attach to a failing tool call, or null when the schema is
 * not the problem.
 *
 * This is deliberately NOT a matcher on the failing error. Handlers throw
 * `new Error("Failed to create customer: " + error.message)`, discarding the
 * PostgREST code, so the only way to identify a setup failure from the error
 * itself would be to pattern-match its message text. That is brittle and would
 * eventually misfile a genuine bug as a setup problem.
 *
 * Instead we ignore the error and ask the database directly whether the schema
 * is present. If it is, the caller's error is a real error and passes through
 * untouched. If it is not, every tool call is failing for that reason anyway,
 * so attaching the guidance is correct rather than a guess.
 */
export async function getSetupGuidanceForFailure(
  db: ToolContext["db"] | undefined
): Promise<Pick<SchemaState, "status" | "guidance"> | null> {
  if (!db) return null;
  const state = await getSchemaState(db);
  if (isHealthy(state.status) || state.status === "unknown") return null;
  if (!state.guidance) return null;
  return { status: state.status, guidance: state.guidance };
}

/**
 * A one-line nudge for the orienting tools (show_capabilities,
 * get_session_start) so a session against an unprovisioned database says so
 * before the user hits a failure. Null when nothing needs doing.
 */
export async function getSchemaHint(
  db: ToolContext["db"] | undefined
): Promise<string | null> {
  if (!db) return null;
  const state = await getSchemaState(db);
  if (isHealthy(state.status) || state.status === "unknown") return null;
  return state.guidance;
}
