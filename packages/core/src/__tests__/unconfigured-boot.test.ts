// ============================================================
// Founders OS - The server boots without credentials
// ============================================================
// An unconfigured server must START, register every tool, and
// answer tools/list. It fails only when a tool actually needs
// the database, and then with a readable message.
//
// Why this matters twice over:
//
// 1. UX. The stdio server builds its context at module load.
//    Throwing there kills the process before the MCP handshake,
//    and the user sees only "server failed to start" - the one
//    place they cannot read the reason.
//
// 2. Discovery. A registry scan of the packaged bundle boots it
//    with no configuration to enumerate capabilities. A process
//    that exits with code 1 reports ZERO tools for a server that
//    has over a hundred, which is exactly how Smithery scored
//    Capability Quality at 0 of 40.
//
// Test ordering note: createServiceClient caches a real client in
// module scope once credentials exist. Every test here runs
// unconfigured, and the unconfigured path is deliberately NOT
// cached, so no ordering hazard exists in this file. Do not add a
// configured-client test here without accounting for that cache.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createServiceClient,
  hasCredentials,
  MISSING_CREDENTIALS_MESSAGE,
} from "../supabase.js";
import { buildContext, _resetContextForTests } from "../context.js";
import {
  getSchemaState,
  getSchemaHint,
  getSetupGuidanceForFailure,
  resetSchemaStateCache,
} from "../schema-state.js";

const CREDS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of CREDS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetSchemaStateCache();
});

afterEach(() => {
  for (const k of CREDS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetSchemaStateCache();
});

describe("hasCredentials", () => {
  it("is false when unset", () => {
    expect(hasCredentials()).toBe(false);
  });

  it("is false when blank, because an MCPB dialog substitutes \"\"", () => {
    process.env.SUPABASE_URL = "";
    process.env.SUPABASE_SECRET_KEY = "";
    expect(hasCredentials()).toBe(false);
  });

  it("is false when only one of the pair is present", () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    expect(hasCredentials()).toBe(false);
  });

  it("is true when both are set", () => {
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_x";
    expect(hasCredentials()).toBe(true);
  });
});

describe("createServiceClient without credentials", () => {
  it("returns a client instead of throwing", () => {
    // This is the whole fix. Throwing here is what killed the process
    // before any tool could be registered.
    expect(() => createServiceClient()).not.toThrow();
    expect(createServiceClient()).toBeDefined();
  });

  it("throws an actionable message when the client is actually used", () => {
    const db = createServiceClient();
    expect(() => db.from("customers")).toThrow(/not configured yet/i);
    expect(() => db.from("customers")).toThrow(/foundersmcp\.com\/setup/);
  });

  it("fails the same way whichever call shape a caller reaches for", () => {
    const db = createServiceClient();
    for (const call of [
      () => db.from("customers"),
      () => db.rpc("anything"),
      () => (db as unknown as { schema: (s: string) => unknown }).schema("public"),
    ]) {
      expect(call).toThrow(MISSING_CREDENTIALS_MESSAGE);
    }
  });

  it("does not detonate on an accidental await", () => {
    // A thenable proxy would hijack promise resolution and surface a
    // configuration error from code that never touched the database.
    const db = createServiceClient() as unknown as { then?: unknown };
    expect(db.then).toBeUndefined();
  });

  it("survives being stringified, for logging and error formatting", () => {
    const db = createServiceClient();
    expect(() => String(db)).not.toThrow();
  });
});

describe("buildContext without credentials", () => {
  beforeEach(() => _resetContextForTests());
  afterEach(() => _resetContextForTests());

  it("builds a usable context instead of throwing at startup", () => {
    expect(() => buildContext()).not.toThrow();
  });

  it("falls back to the placeholder identity and default embedding config", () => {
    const ctx = buildContext();
    expect(ctx.companyId).toBe("myawesomecompany");
    expect(ctx.userId).toBe("foundersuser1");
    expect(ctx.embedding.provider).toBe("openai");
    expect(ctx.db).toBeDefined();
  });
});

describe("schema state reports not_configured, not a database error", () => {
  it("names configuration as the problem", async () => {
    const state = await getSchemaState(createServiceClient());
    expect(state.status).toBe("not_configured");
    expect(state.dbVersion).toBeNull();
  });

  it("guides the user to credentials rather than to setup.sql", async () => {
    // The distinction matters. Telling someone with no credentials to go run
    // SQL sends them to the wrong place entirely.
    const state = await getSchemaState(createServiceClient());
    expect(state.guidance).toMatch(/SUPABASE_URL/);
    expect(state.guidance).not.toMatch(/migrations/i);
  });

  it("does not report unknown, which would imply an inconclusive probe", async () => {
    // "unknown" means we could not tell. Here we can tell exactly.
    const state = await getSchemaState(createServiceClient());
    expect(state.status).not.toBe("unknown");
  });

  it("attaches guidance to a failing tool call", async () => {
    const g = await getSetupGuidanceForFailure(createServiceClient());
    expect(g?.status).toBe("not_configured");
    expect(g?.guidance).toBeTruthy();
  });

  it("surfaces a hint from the orienting tools", async () => {
    expect(await getSchemaHint(createServiceClient())).toMatch(/credentials/i);
  });

  it("never probes the database, so no thrower is ever touched", async () => {
    // The config check runs before the client is used. If it did not, the
    // proxy would throw inside probe() and the status would degrade to
    // "unknown", losing the specific and actionable answer.
    await expect(getSchemaState(createServiceClient())).resolves.toBeDefined();
  });
});
