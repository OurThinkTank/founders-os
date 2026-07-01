// ============================================================
// Founders OS — tick runner selection (T2.1)
// ============================================================
// selectRunner is the pure routing decision for `founders-os-tick run`.
// The SDK adapter and env helpers in agent-runner.ts are exercised on a
// provisioned host, not here.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { selectRunner, loadConnectorPolicy } from "../agent-runner.js";

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

describe("loadConnectorPolicy (S2.1: inline or file)", () => {
  const tmpFiles: string[] = [];
  // Clear both before AND after each test so the suite is hermetic even when
  // the runner's shell already exports a real policy (e.g. the live Slack demo).
  beforeEach(() => {
    delete process.env.FOUNDERSOS_CONNECTOR_POLICY;
    delete process.env.FOUNDERSOS_CONNECTOR_POLICY_FILE;
  });
  afterEach(() => {
    delete process.env.FOUNDERSOS_CONNECTOR_POLICY;
    delete process.env.FOUNDERSOS_CONNECTOR_POLICY_FILE;
    for (const f of tmpFiles.splice(0)) rmSync(f, { force: true });
  });

  function writeTmp(content: string): string {
    const p = join(tmpdir(), `fos-policy-${randomUUID()}.json`);
    writeFileSync(p, content);
    tmpFiles.push(p);
    return p;
  }

  const slackPolicy = { slack: { actions: ["slack_send_message"], scopeField: "channel_id", scopes: ["C0X"] } };

  it("returns {} (stage-only) when neither is set", () => {
    expect(loadConnectorPolicy()).toEqual({});
  });

  it("reads inline JSON from FOUNDERSOS_CONNECTOR_POLICY", () => {
    process.env.FOUNDERSOS_CONNECTOR_POLICY = JSON.stringify(slackPolicy);
    expect(loadConnectorPolicy()).toEqual(slackPolicy);
  });

  it("reads a policy file from FOUNDERSOS_CONNECTOR_POLICY_FILE", () => {
    process.env.FOUNDERSOS_CONNECTOR_POLICY_FILE = writeTmp(JSON.stringify(slackPolicy));
    expect(loadConnectorPolicy()).toEqual(slackPolicy);
  });

  it("inline wins when both are set (back-compat)", () => {
    process.env.FOUNDERSOS_CONNECTOR_POLICY = JSON.stringify(slackPolicy);
    process.env.FOUNDERSOS_CONNECTOR_POLICY_FILE = writeTmp(JSON.stringify({ slack: { actions: ["OTHER"] } }));
    expect(loadConnectorPolicy()).toEqual(slackPolicy);
  });

  it("throws a clear error when the file path is set but unreadable", () => {
    process.env.FOUNDERSOS_CONNECTOR_POLICY_FILE = join(tmpdir(), `fos-missing-${randomUUID()}.json`);
    expect(() => loadConnectorPolicy()).toThrow(/FOUNDERSOS_CONNECTOR_POLICY_FILE/);
  });
});
