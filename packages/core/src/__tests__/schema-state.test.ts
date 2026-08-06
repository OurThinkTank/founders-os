// ============================================================
// Founders OS - Database schema state + setup guidance
// ============================================================
// Covers schema-state.ts, the guided preflight from runbook
// section 4a (P4).
//
// The single most important case in this file is the negative one:
// when the schema is HEALTHY, a failing tool call must pass its
// error through completely unchanged. Over-broad matching here
// would mask real bugs behind a "you need to run setup" message,
// which is a worse failure than the one the preflight fixes.
//
// This is why the implementation never inspects the failing error.
// Handlers throw `new Error("Failed to X: " + error.message)` and
// discard the PostgREST code, so matching the error itself would
// mean matching message text. Instead we ask the database whether
// the schema is present and let that decide.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  getSchemaState,
  getSchemaHint,
  getSetupGuidanceForFailure,
  resetSchemaStateCache,
} from "../schema-state.js";
import { EXPECTED_SCHEMA_VERSION } from "../schema-version.js";
import type { ToolContext } from "../types/context.js";

// ── Fake Supabase client ───────────────────────────────────────────────────
// Models just enough of the PostgREST surface that schema-state.ts touches:
//   db.from(t).select().eq().maybeSingle()      -> marker read
//   db.from(t).select(_, {head:true})           -> canary probe
type TableResult = { data?: unknown; error?: { code?: string; message: string } };

interface FakeOpts {
  /** Result for the founders_os_meta marker read. */
  meta: TableResult;
  /** Result for the customers canary probe. */
  canary?: TableResult;
}

function fakeDb(opts: FakeOpts): { db: ToolContext["db"]; calls: string[] } {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      calls.push(table);
      const result = table === "customers" ? (opts.canary ?? { data: null }) : opts.meta;
      const thenable = {
        select: () => thenable,
        eq: () => thenable,
        maybeSingle: async () => result,
        // The canary uses select(..., {head:true}) with no maybeSingle, so the
        // builder itself must be awaitable.
        then: (resolve: (v: TableResult) => unknown) => resolve(result),
      };
      return thenable;
    },
  } as unknown as ToolContext["db"];
  return { db, calls };
}

const MISSING_TABLE = { error: { code: "PGRST205", message: "Could not find the table" } };
const MISSING_TABLE_PG = { error: { code: "42P01", message: 'relation "x" does not exist' } };
const marker = (v: number) => ({ data: { value: String(v) } });

beforeEach(() => {
  resetSchemaStateCache();
});

describe("getSchemaState - classification", () => {
  it("reports current when the marker matches", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    const s = await getSchemaState(db);
    expect(s.status).toBe("current");
    expect(s.dbVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(s.guidance).toBeNull();
  });

  it("reports behind and names the exact migration range", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION - 2) });
    const s = await getSchemaState(db);
    expect(s.status).toBe("behind");
    // Range runs from the next unapplied file through the expected version.
    const from = String(EXPECTED_SCHEMA_VERSION - 1).padStart(3, "0");
    const to = String(EXPECTED_SCHEMA_VERSION).padStart(3, "0");
    expect(s.guidance).toContain(from);
    expect(s.guidance).toContain(to);
  });

  it("reports ahead and points at updating the connector, not the database", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION + 1) });
    const s = await getSchemaState(db);
    expect(s.status).toBe("ahead");
    expect(s.guidance).toMatch(/do not change the database/i);
  });

  it("reports missing when neither the marker nor a core table exists", async () => {
    const { db } = fakeDb({ meta: MISSING_TABLE, canary: MISSING_TABLE });
    const s = await getSchemaState(db);
    expect(s.status).toBe("missing");
    expect(s.guidance).toContain("foundersmcp.com/setup");
  });

  it("distinguishes a legacy install from a blank one", async () => {
    // Marker absent but the core table is there: an old install that predates
    // schema-version tracking. Opposite advice from a blank database.
    const { db } = fakeDb({ meta: MISSING_TABLE, canary: { data: null } });
    const s = await getSchemaState(db);
    expect(s.status).toBe("untracked");
    expect(s.guidance).toMatch(/SCHEMA VERSION MARKER/);
  });

  it("treats the raw Postgres undefined_table code the same as the PostgREST one", async () => {
    const { db } = fakeDb({ meta: MISSING_TABLE_PG, canary: MISSING_TABLE_PG });
    expect((await getSchemaState(db)).status).toBe("missing");
  });

  it("reports untracked when the table exists but carries no marker row", async () => {
    const { db } = fakeDb({ meta: { data: null } });
    const s = await getSchemaState(db);
    expect(s.status).toBe("untracked");
  });

  it("reports unknown on a non-missing-table error and never throws", async () => {
    const { db } = fakeDb({
      meta: { error: { code: "PGRST301", message: "JWT expired" } },
    });
    const s = await getSchemaState(db);
    expect(s.status).toBe("unknown");
    expect(s.error).toBe("JWT expired");
    expect(s.guidance).toBeNull();
  });

  it("does not claim the database is blank when the canary fails for another reason", async () => {
    // A permissions error on the canary is not evidence of absence. Calling it
    // "missing" would tell the user to re-run setup on a populated database.
    const { db } = fakeDb({
      meta: MISSING_TABLE,
      canary: { error: { code: "42501", message: "permission denied" } },
    });
    expect((await getSchemaState(db)).status).toBe("untracked");
  });

  it("skips the canary probe entirely when the marker reads fine", async () => {
    const { db, calls } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    await getSchemaState(db);
    expect(calls).toEqual(["founders_os_meta"]);
  });
});

describe("getSchemaState - caching", () => {
  it("caches a healthy result so repeat calls cost no queries", async () => {
    const { db, calls } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    await getSchemaState(db);
    await getSchemaState(db);
    await getSchemaState(db);
    expect(calls).toHaveLength(1);
  });

  it("re-probes after the cache is reset, so a fixed database is picked up", async () => {
    // The user is told to run setup.sql. They do. Without re-probing, the
    // server would keep insisting the schema is missing until the app restarts.
    const broken = fakeDb({ meta: MISSING_TABLE, canary: MISSING_TABLE });
    expect((await getSchemaState(broken.db)).status).toBe("missing");

    resetSchemaStateCache();

    const fixed = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    expect((await getSchemaState(fixed.db)).status).toBe("current");
  });
});

describe("getSetupGuidanceForFailure - the negative case", () => {
  it("returns null on a healthy schema so real errors pass through untouched", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    expect(await getSetupGuidanceForFailure(db)).toBeNull();
  });

  it("returns null when the schema is ahead", async () => {
    // Ahead is a connector problem, not a setup problem. A failing tool call
    // in that state should not be relabelled as needing setup.
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION + 1) });
    expect(await getSetupGuidanceForFailure(db)).toBeNull();
  });

  it("returns null when the probe itself is inconclusive", async () => {
    // Offline or bad credentials. We do not know the schema is the problem,
    // so we must not say it is.
    const { db } = fakeDb({
      meta: { error: { code: "PGRST301", message: "JWT expired" } },
    });
    expect(await getSetupGuidanceForFailure(db)).toBeNull();
  });

  it("returns null when there is no client at all", async () => {
    expect(await getSetupGuidanceForFailure(undefined)).toBeNull();
  });

  it("returns guidance when the schema really is missing", async () => {
    const { db } = fakeDb({ meta: MISSING_TABLE, canary: MISSING_TABLE });
    const g = await getSetupGuidanceForFailure(db);
    expect(g?.status).toBe("missing");
    expect(g?.guidance).toContain("foundersmcp.com/setup");
  });

  it("returns guidance when the schema is behind", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION - 1) });
    expect((await getSetupGuidanceForFailure(db))?.status).toBe("behind");
  });
});

describe("getSchemaHint", () => {
  it("is null on a healthy schema", async () => {
    const { db } = fakeDb({ meta: marker(EXPECTED_SCHEMA_VERSION) });
    expect(await getSchemaHint(db)).toBeNull();
  });

  it("is null without a client", async () => {
    expect(await getSchemaHint(undefined)).toBeNull();
  });

  it("returns the setup sentence on a blank database", async () => {
    const { db } = fakeDb({ meta: MISSING_TABLE, canary: MISSING_TABLE });
    expect(await getSchemaHint(db)).toContain("foundersmcp.com/setup");
  });
});
