// S6.1 — auto-send last mile: the full-run wrapper variant, the SDK/API-key
// preflight, the plan wiring, and the doctor auto-dispatch status line. All
// pure/deterministic, so this runs anywhere.

import { describe, it, expect } from "vitest";
import { WRAPPER_SH, WRAPPER_CMD, wrapperSh, wrapperCmd } from "../setup/generators.js";
import { buildInitPlan, type InitConfig } from "../setup/plan.js";
import { checkAgentSdk, apiKeyVarFor, isAgentSdkInstalled, AGENT_SDK_PKG, type SdkCheck } from "../setup/sdk.js";
import { readScheduleMode, describeAutodispatch } from "../setup/doctor.js";
import { computePosture, renderPosture, RUNGS, type PostureInput } from "../setup/posture.js";
import type { ManagedPaths, UnitPaths } from "../setup/paths.js";

// ── wrapper posture transform ──────────────────────────────

describe("wrapperSh / wrapperCmd run posture", () => {
  it("hold-only is byte-identical to the parity-guarded canonical body", () => {
    expect(wrapperSh("hold-only")).toBe(WRAPPER_SH);
    expect(wrapperCmd("hold-only")).toBe(WRAPPER_CMD);
  });

  it("execute swaps the run posture to --execute and leaves no hold-only", () => {
    const sh = wrapperSh("execute");
    expect(sh).toContain('"${TICK_CMD[@]}" run --execute --json');
    expect(sh).not.toContain("run --hold-only");
    const cmd = wrapperCmd("execute");
    expect(cmd).toContain("call %TICK% run --execute --json");
    expect(cmd).not.toContain("run --hold-only");
  });

  it("execute keeps the operational machinery intact (env sourcing, PATH, argv split, logging)", () => {
    const sh = wrapperSh("execute");
    expect(sh).toContain('. "$ENV_FILE"'); // sources the env file
    expect(sh).toContain('export PATH="/opt/homebrew/bin'); // PATH augmentation
    expect(sh).toContain("read -r -a TICK_CMD"); // argv split
    expect(sh).toContain("[tick-wrapper] done"); // doctor's log marker
    // still runs detect first, then the run step
    expect(sh).toContain('"${TICK_CMD[@]}" detect --json');
  });
});

// ── plan wires the wrapper posture to the execute flag ─────

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

describe("buildInitPlan wires the wrapper to the run posture", () => {
  it("default (hold-only) writes a hold-only wrapper", () => {
    const plan = buildInitPlan(cfg());
    const w = plan.files.find((f) => f.path === paths.wrapperUnix)!.content;
    expect(w).toContain("run --hold-only");
    expect(w).not.toContain("run --execute");
  });

  it("execute=true writes a full-run wrapper", () => {
    const plan = buildInitPlan(cfg({ execute: true }));
    const w = plan.files.find((f) => f.path === paths.wrapperUnix)!.content;
    expect(w).toContain("run --execute");
    expect(w).not.toContain("run --hold-only");
  });

  it("execute=true on Windows writes a full-run .cmd wrapper", () => {
    const plan = buildInitPlan(cfg({ os: "windows", scheduler: "taskscheduler", execute: true }));
    const w = plan.files.find((f) => f.path === paths.wrapperWin)!.content;
    expect(w).toContain("run --execute");
    expect(w).not.toContain("run --hold-only");
  });
});

// ── SDK / API-key preflight ────────────────────────────────

describe("checkAgentSdk", () => {
  it("apiKeyVarFor maps provider to the right env var", () => {
    expect(apiKeyVarFor("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(apiKeyVarFor("openai")).toBe("OPENAI_API_KEY");
    expect(apiKeyVarFor(undefined as unknown as string)).toBe("ANTHROPIC_API_KEY");
  });

  it("reports a missing API key (anthropic default) and is not ready without it", () => {
    const c = checkAgentSdk({}); // no provider, no key
    expect(c.provider).toBe("anthropic");
    expect(c.apiKeyVar).toBe("ANTHROPIC_API_KEY");
    expect(c.apiKey).toBe(false);
    expect(c.ready).toBe(false);
    expect(c.detail).toContain("ANTHROPIC_API_KEY not set");
  });

  it("sees the key when set, and honors the openai provider", () => {
    expect(checkAgentSdk({ ANTHROPIC_API_KEY: "sk-ant-x" }).apiKey).toBe(true);
    const o = checkAgentSdk({ FOUNDERSOS_AGENT_PROVIDER: "openai", OPENAI_API_KEY: "sk-oai-x" });
    expect(o.apiKeyVar).toBe("OPENAI_API_KEY");
    expect(o.apiKey).toBe(true);
  });

  it("readiness is SDK-installed AND api-key-present", () => {
    const installed = isAgentSdkInstalled();
    expect(typeof installed).toBe("boolean");
    // No key => never ready, regardless of the SDK.
    expect(checkAgentSdk({}).ready).toBe(false);
    // Key present => ready exactly when the optional peer dep resolves.
    expect(checkAgentSdk({ ANTHROPIC_API_KEY: "sk-ant-x" }).ready).toBe(installed);
  });
});

// ── doctor auto-dispatch status ────────────────────────────

describe("readScheduleMode", () => {
  it("classifies the installed wrapper by its run posture", () => {
    expect(readScheduleMode("")).toBe("none");
    expect(readScheduleMode(wrapperSh("execute"))).toBe("execute");
    expect(readScheduleMode(wrapperSh("hold-only"))).toBe("hold-only");
  });
});

describe("describeAutodispatch", () => {
  const sdk = (over: Partial<SdkCheck>): SdkCheck => ({
    sdkInstalled: true,
    apiKey: true,
    provider: "anthropic",
    apiKeyVar: "ANTHROPIC_API_KEY",
    ready: true,
    detail: "",
    ...over,
  });

  it("no schedule → points at init --execute, not ready", () => {
    const s = describeAutodispatch("none", sdk({}));
    expect(s.ready).toBe(false);
    expect(s.label).toContain("init --execute");
  });

  it("hold-only schedule → points at autosend, not ready", () => {
    const s = describeAutodispatch("hold-only", sdk({}));
    expect(s.ready).toBe(false);
    expect(s.label).toContain("autosend");
  });

  it("execute but SDK missing → flags the SDK", () => {
    const s = describeAutodispatch("execute", sdk({ sdkInstalled: false }));
    expect(s.ready).toBe(false);
    expect(s.label).toContain(AGENT_SDK_PKG);
  });

  it("execute + SDK but no key → flags the key", () => {
    const s = describeAutodispatch("execute", sdk({ apiKey: false }));
    expect(s.ready).toBe(false);
    expect(s.label).toContain("ANTHROPIC_API_KEY");
  });

  it("execute + SDK + key → ready", () => {
    const s = describeAutodispatch("execute", sdk({}));
    expect(s.ready).toBe(true);
    expect(s.label).toContain("ready");
  });
});

// ── S6.2 posture ladder ────────────────────────────────────

describe("computePosture", () => {
  const readySdk = { sdkInstalled: true, apiKey: true, provider: "anthropic", apiKeyVar: "ANTHROPIC_API_KEY", ready: true, detail: "" };
  const input = (over: Partial<PostureInput> = {}): PostureInput => ({
    scheduleRegistered: true,
    scheduleMode: "hold-only",
    autosendOn: false,
    tierKnown: true,
    connectorConfigured: true,
    sdk: readySdk,
    paused: false,
    ...over,
  });

  it("rung 0 when nothing is registered", () => {
    const p = computePosture(input({ scheduleRegistered: false }));
    expect(p.rung).toBe(0);
    expect(p.title).toBe("Not set up");
    expect(p.nextStep?.how).toBe("founders-os-tick init");
  });

  it("rung 0 when the wrapper mode is none even if 'registered'", () => {
    expect(computePosture(input({ scheduleMode: "none" })).rung).toBe(0);
  });

  it("rung 1 (Preparing): hold-only, healthy, next step is Triaging", () => {
    const p = computePosture(input({ scheduleMode: "hold-only" }));
    expect(p.rung).toBe(1);
    expect(p.title).toBe("Preparing");
    expect(p.healthy).toBe(true);
    expect(p.nextStep?.toTitle).toBe("Triaging");
    expect(p.nextStep?.how).toBe("founders-os-tick init --execute");
  });

  it("rung 1 but tier already allows sending → flagged as a mismatch to fix", () => {
    const p = computePosture(input({ scheduleMode: "hold-only", autosendOn: true }));
    expect(p.rung).toBe(1);
    expect(p.healthy).toBe(false);
    expect(p.blockers.join(" ")).toContain("autosend slack --on");
  });

  it("rung 2 (Triaging): execute + hold tier + ready, next step is Sending", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: false }));
    expect(p.rung).toBe(2);
    expect(p.title).toBe("Triaging");
    expect(p.healthy).toBe(true);
    expect(p.nextStep?.toTitle).toBe("Sending routine items");
    expect(p.nextStep?.how).toBe("founders-os-tick autosend slack --on");
  });

  it("rung 2 with no connector: next-step how tells you to connect first", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: false, connectorConfigured: false }));
    expect(p.nextStep?.how).toContain("connect slack");
  });

  it("rung 2 missing API key → not healthy, blocker names the var", () => {
    const p = computePosture(input({ scheduleMode: "execute", sdk: { ...readySdk, apiKey: false, ready: false } }));
    expect(p.healthy).toBe(false);
    expect(p.blockers.join(" ")).toContain("ANTHROPIC_API_KEY");
  });

  it("rung 2 SDK didn't resolve → blocker says reinstall", () => {
    const p = computePosture(input({ scheduleMode: "execute", sdk: { ...readySdk, sdkInstalled: false, ready: false } }));
    expect(p.healthy).toBe(false);
    expect(p.blockers.join(" ")).toContain("Reinstall");
  });

  it("rung 3 (Sending): execute + allow + connector + ready, healthy, top of the ladder", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: true }));
    expect(p.rung).toBe(3);
    expect(p.title).toBe("Sending routine items");
    expect(p.healthy).toBe(true);
    expect(p.nextStep).toBeUndefined();
  });

  it("rung 3 with no connector → blocker says connect a channel", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: true, connectorConfigured: false }));
    expect(p.healthy).toBe(false);
    expect(p.blockers.join(" ")).toContain("connect slack");
  });

  it("paused is a blocker at a model rung", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: true, paused: true }));
    expect(p.healthy).toBe(false);
    expect(p.blockers.join(" ").toLowerCase()).toContain("paused");
  });

  it("tier unknown at execute is surfaced, not guessed", () => {
    const p = computePosture(input({ scheduleMode: "execute", autosendOn: false, tierKnown: false }));
    expect(p.rung).toBe(2);
    expect(p.doing.toLowerCase()).toContain("couldn't read");
  });
});

describe("renderPosture", () => {
  const readySdk = { sdkInstalled: true, apiKey: true, provider: "anthropic", apiKeyVar: "ANTHROPIC_API_KEY", ready: true, detail: "" };
  it("renders where-you-are, all three rungs, and the next step", () => {
    const p = computePosture({
      scheduleRegistered: true,
      scheduleMode: "hold-only",
      autosendOn: false,
      tierKnown: true,
      connectorConfigured: false,
      sdk: readySdk,
      paused: false,
    });
    const text = renderPosture(p);
    expect(text).toContain("Where you are:");
    expect(text).toContain("The ladder:");
    for (const r of RUNGS) expect(text).toContain(r.title);
    expect(text).toContain("(you're here)");
    expect(text).toContain("How:");
  });

  it("shows blockers when not healthy", () => {
    const p = computePosture({
      scheduleRegistered: true,
      scheduleMode: "execute",
      autosendOn: true,
      tierKnown: true,
      connectorConfigured: false,
      sdk: { ...readySdk, apiKey: false, ready: false },
      paused: false,
    });
    const text = renderPosture(p);
    expect(text).toContain("NEEDS ATTENTION");
    expect(text).toContain("ANTHROPIC_API_KEY");
  });
});
