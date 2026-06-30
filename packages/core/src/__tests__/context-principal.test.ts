// ============================================================
// Founders OS — Launch principal (T0.1)
// ============================================================
// FOUNDERSOS_PRINCIPAL=autonomous makes the stdio MCP server build an
// autonomous context, so a scheduled runtime that launches the server
// arms the hard gate (reduced governance map + holds floored to staged)
// without the in-process runner. Default (unset) stays interactive.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readPrincipalFromEnv, buildContext, _resetContextForTests } from "../context.js";
import { isAutonomous } from "../types/context.js";

const SAVED = { ...process.env };

beforeEach(() => {
  _resetContextForTests();
  // Minimal env so buildContext can construct the (lazily-connecting) client.
  process.env.SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SECRET_KEY = "test-secret";
  delete process.env.FOUNDERSOS_PRINCIPAL;
  delete process.env.FOUNDERSOS_RUN_ID;
});

afterEach(() => {
  process.env = { ...SAVED };
  _resetContextForTests();
});

describe("readPrincipalFromEnv", () => {
  it("defaults to interactive when unset", () => {
    expect(readPrincipalFromEnv()).toBe("interactive");
  });

  it("reads autonomous case-insensitively", () => {
    process.env.FOUNDERSOS_PRINCIPAL = "Autonomous";
    expect(readPrincipalFromEnv()).toBe("autonomous");
  });

  it("throws on an unknown value", () => {
    process.env.FOUNDERSOS_PRINCIPAL = "robot";
    expect(() => readPrincipalFromEnv()).toThrow(/FOUNDERSOS_PRINCIPAL/);
  });
});

describe("buildContext principal wiring", () => {
  it("builds an interactive actor by default", () => {
    const ctx = buildContext();
    expect(ctx.actor?.kind).toBe("interactive");
    expect(isAutonomous(ctx)).toBe(false);
    expect(ctx.identityMode).toBe("env");
  });

  it("builds an autonomous actor under FOUNDERSOS_PRINCIPAL=autonomous (arms the hard gate)", () => {
    process.env.FOUNDERSOS_PRINCIPAL = "autonomous";
    const ctx = buildContext();
    expect(ctx.actor?.kind).toBe("autonomous");
    expect(isAutonomous(ctx)).toBe(true);
    expect(ctx.identityMode).toBe("background");
    // No model is read here: the runtime owns the loop, not the server.
    expect(ctx.agentModel).toBeUndefined();
  });

  it("uses FOUNDERSOS_RUN_ID for run attribution when provided", () => {
    process.env.FOUNDERSOS_PRINCIPAL = "autonomous";
    process.env.FOUNDERSOS_RUN_ID = "sched-run-42";
    const ctx = buildContext();
    expect(ctx.actor).toEqual({ kind: "autonomous", runId: "sched-run-42" });
  });
});
