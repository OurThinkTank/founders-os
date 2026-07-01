// Pure-logic tests for the S1 installer core: the init plan, the register
// command builders, the crontab merge, and the doctor parsers. Nothing here
// touches the real scheduler, so it runs anywhere.

import { describe, it, expect } from "vitest";
import { buildInitPlan, type InitConfig } from "../setup/plan.js";
import {
  buildRegisterCommands,
  mergeCrontab,
  parseLaunchctlList,
  parseSystemctlEnabled,
  crontabHasTag,
  CRON_TAG,
} from "../setup/registrar.js";
import { parseLastRun, readEnvValue } from "../setup/doctor.js";
import type { ManagedPaths, UnitPaths } from "../setup/paths.js";

const paths: ManagedPaths = {
  configDir: "/home/me/.config/founders-os",
  envFile: "/home/me/.config/founders-os/foundersos-tick.env",
  wrapperUnix: "/home/me/.config/founders-os/foundersos-tick.sh",
  wrapperWin: "/home/me/.config/founders-os/foundersos-tick.cmd",
  policyFile: "/home/me/.config/founders-os/connector-policy.json",
  connectorsFile: "/home/me/.config/founders-os/runner-connectors.json",
  logFile: "/home/me/.local/state/foundersos-tick.log",
};
const units: UnitPaths = {
  launchdPlist: "/home/me/Library/LaunchAgents/com.foundersos.tick.plist",
  systemdService: "/home/me/.config/systemd/user/foundersos-tick.service",
  systemdTimer: "/home/me/.config/systemd/user/foundersos-tick.timer",
};
const creds = { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_abc" };

function cfg(over: Partial<InitConfig> = {}): InitConfig {
  return { os: "macos", scheduler: "launchd", cadence: "hourly", dailyHour: 6, execute: false, tickBin: "npx tick", creds, paths, units, ...over };
}

describe("buildInitPlan", () => {
  it("macOS/launchd: writes env (600), wrapper (755), plist (644) and loads it", () => {
    const plan = buildInitPlan(cfg());
    const byPath = Object.fromEntries(plan.files.map((f) => [f.path, f]));
    expect(byPath[paths.envFile].mode).toBe(0o600);
    expect(byPath[paths.envFile].content).toContain("SUPABASE_URL=https://x.supabase.co");
    expect(byPath[paths.envFile].content).toContain("FOUNDERSOS_TICK_BIN=");
    expect(byPath[paths.wrapperUnix].mode).toBe(0o755);
    expect(byPath[units.launchdPlist].mode).toBe(0o644);
    expect(byPath[units.launchdPlist].content).toContain(paths.wrapperUnix); // absolute, no ~
    expect(byPath[units.launchdPlist].content).not.toContain("~/");
    expect(plan.register.some((c) => c.kind === "exec" && c.cmd === "launchctl")).toBe(true);
  });

  it("Linux/systemd: writes service + timer and enables the timer", () => {
    const plan = buildInitPlan(cfg({ os: "linux", scheduler: "systemd" }));
    const written = plan.files.map((f) => f.path);
    expect(written).toContain(units.systemdService);
    expect(written).toContain(units.systemdTimer);
    expect(plan.register.some((c) => c.kind === "exec" && c.cmd === "systemctl" && c.args.includes("--now"))).toBe(true);
  });

  it("cron: writes no unit file, registers a cron-add", () => {
    const plan = buildInitPlan(cfg({ os: "linux", scheduler: "cron" }));
    expect(plan.files.find((f) => f.path.includes("systemd"))).toBeUndefined();
    expect(plan.register).toHaveLength(1);
    expect(plan.register[0].kind).toBe("cron-add");
  });

  it("execute=true adds a default model so it is never unset (S2.2)", () => {
    const plan = buildInitPlan(cfg({ execute: true }));
    const env = plan.files.find((f) => f.path === paths.envFile)!.content;
    expect(env).toContain("FOUNDERSOS_AGENT_MODEL=claude-sonnet-5");
    // the real line is present, so the commented example is suppressed
    expect(env).not.toContain("#   FOUNDERSOS_AGENT_MODEL=");
  });

  it("hold-only (default) leaves a commented model block for discoverability (S2.2)", () => {
    const plan = buildInitPlan(cfg({ execute: false }));
    const env = plan.files.find((f) => f.path === paths.envFile)!.content;
    expect(env).not.toContain("\nFOUNDERSOS_AGENT_MODEL="); // not active
    expect(env).toContain("#   FOUNDERSOS_AGENT_MODEL=claude-sonnet-5"); // commented guidance
    expect(env).toContain("run --execute");
  });

  it("Windows is deferred to S4", () => {
    expect(() => buildInitPlan(cfg({ os: "windows" }))).toThrow(/Windows/);
  });
});

describe("buildRegisterCommands", () => {
  it("launchd unloads before loading (idempotent re-run)", () => {
    const cmds = buildRegisterCommands({ os: "macos", scheduler: "launchd", units, cronLine: "" });
    expect(cmds[0]).toMatchObject({ kind: "exec", cmd: "launchctl", ignoreError: true });
    expect(cmds[0].kind === "exec" && cmds[0].args[0]).toBe("unload");
    expect(cmds[1].kind === "exec" && cmds[1].args).toContain("-w");
  });
});

describe("mergeCrontab", () => {
  it("replaces a prior tagged line rather than duplicating", () => {
    const before = `0 * * * * /old/foundersos-tick.sh ${CRON_TAG}\n0 9 * * * /other/job\n`;
    const merged = mergeCrontab(before, "0 * * * * /new/foundersos-tick.sh", CRON_TAG);
    expect(merged).toContain("/new/foundersos-tick.sh");
    expect(merged).not.toContain("/old/foundersos-tick.sh");
    expect(merged).toContain("/other/job"); // unrelated lines kept
    expect(merged.match(new RegExp(CRON_TAG, "g"))?.length).toBe(1); // exactly one tick line
  });
  it("appends when no prior line exists", () => {
    expect(mergeCrontab("", "0 * * * * /x.sh", CRON_TAG)).toBe(`0 * * * * /x.sh ${CRON_TAG}\n`);
  });
});

describe("status parsers", () => {
  it("parseLaunchctlList finds the label", () => {
    expect(parseLaunchctlList("123\t0\tcom.apple.foo\n-\t0\tcom.foundersos.tick\n")).toBe(true);
    expect(parseLaunchctlList("123\t0\tcom.apple.foo\n")).toBe(false);
  });
  it("parseSystemctlEnabled requires enabled + exit 0", () => {
    expect(parseSystemctlEnabled("enabled\n", 0)).toBe(true);
    expect(parseSystemctlEnabled("disabled\n", 1)).toBe(false);
    expect(parseSystemctlEnabled("enabled\n", 1)).toBe(false);
  });
  it("crontabHasTag detects the tagged line", () => {
    expect(crontabHasTag(`0 * * * * /x.sh ${CRON_TAG}\n`, CRON_TAG)).toBe(true);
    expect(crontabHasTag("0 * * * * /x.sh\n", CRON_TAG)).toBe(false);
  });
});

describe("doctor parsers", () => {
  it("parseLastRun reads the last completed run and its result", () => {
    const log = [
      "2026-06-30T05:00:00Z [tick-wrapper] start",
      '{"mode":"detect","fired":1}',
      "2026-06-30T05:00:02Z [tick-wrapper] done (detect=0 run=0)",
      "2026-06-30T06:00:00Z [tick-wrapper] start",
      "2026-06-30T06:00:03Z [tick-wrapper] done (detect=0 run=1)",
    ].join("\n");
    const r = parseLastRun(log)!;
    expect(r.at).toBe("2026-06-30T06:00:03Z");
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("detect=0 run=1");
  });
  it("parseLastRun returns null when never run", () => {
    expect(parseLastRun("nothing here\n")).toBeNull();
  });
  it("readEnvValue unquotes a quoted value and skips comments", () => {
    const env = ['# comment', "SUPABASE_URL=https://x.supabase.co", 'FOUNDERSOS_TICK_BIN="npx -y -p pkg tick"'].join("\n");
    expect(readEnvValue(env, "SUPABASE_URL")).toBe("https://x.supabase.co");
    expect(readEnvValue(env, "FOUNDERSOS_TICK_BIN")).toBe("npx -y -p pkg tick");
    expect(readEnvValue(env, "MISSING")).toBeUndefined();
  });
});
