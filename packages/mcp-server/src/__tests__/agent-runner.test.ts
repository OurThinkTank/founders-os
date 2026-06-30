// ============================================================
// Founders OS — tick runner selection (T2.1)
// ============================================================
// selectRunner is the pure routing decision for `founders-os-tick run`.
// The SDK adapter and env helpers in agent-runner.ts are exercised on a
// provisioned host, not here.
// ============================================================

import { describe, it, expect } from "vitest";
import { selectRunner } from "../agent-runner.js";

describe("selectRunner", () => {
  it("routes --execute to the Agent SDK runner by default", () => {
    expect(selectRunner({ execute: true, holdOnly: false })).toBe("agent-sdk");
  });

  it("routes FOUNDERSOS_TICK_RUN_MODE=full to the Agent SDK runner", () => {
    expect(selectRunner({ execute: false, holdOnly: false, runMode: "full" })).toBe("agent-sdk");
  });

  it("routes to the in-process fallback when FOUNDERSOS_TICK_RUNNER=inprocess", () => {
    expect(selectRunner({ execute: true, holdOnly: false, runner: "inprocess" })).toBe("inprocess");
  });

  it("routes --hold-only to the hold-only runner", () => {
    expect(selectRunner({ execute: false, holdOnly: true })).toBe("hold-only");
  });

  it("refuses a bare run with no posture", () => {
    expect(selectRunner({ execute: false, holdOnly: false })).toBe("refuse");
  });

  it("a full request beats --hold-only", () => {
    expect(selectRunner({ execute: true, holdOnly: true })).toBe("agent-sdk");
  });
});
