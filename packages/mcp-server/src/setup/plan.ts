// ============================================================
// Founders OS — init plan (pure)
// ============================================================
// buildInitPlan turns a resolved config into a declarative plan: the exact
// files to write (path + content + mode) and the register commands to run.
// It has no side effects, so a test can assert the whole plan against a tmp
// HOME without touching the real scheduler. init.ts executes the plan.
// ============================================================

import {
  buildLaunchdPlist,
  buildSystemdService,
  buildSystemdTimer,
  buildCronLine,
  buildEnvFile,
  WRAPPER_SH,
  type Cadence,
} from "./generators.js";
import type { ManagedPaths, OsKind, Scheduler, UnitPaths } from "./paths.js";
import { buildRegisterCommands, type Command } from "./registrar.js";

export interface InitConfig {
  os: OsKind;
  scheduler: Scheduler;
  cadence: Cadence;
  dailyHour: number;
  execute: boolean; // wire `run --execute` (writes model config) vs hold-only
  tickBin: string; // FOUNDERSOS_TICK_BIN value the wrapper uses
  creds: Record<string, string>; // SUPABASE_*, FOUNDERS_OS_* the wrapper needs
  paths: ManagedPaths;
  units: UnitPaths;
}

export interface PlannedFile {
  path: string;
  content: string;
  mode: number;
}

export interface InitPlan {
  files: PlannedFile[];
  register: Command[];
  os: OsKind;
  scheduler: Scheduler;
}

// Sensible model default so an --execute opt-in never leaves the model unset
// (unset => SDK default Opus 4.8, the priciest). See S2.2.
const DEFAULT_AGENT_PROVIDER = "anthropic";
const DEFAULT_AGENT_MODEL = "claude-sonnet-5";

export function buildInitPlan(cfg: InitConfig): InitPlan {
  if (cfg.os === "windows") {
    throw new Error("buildInitPlan: Windows registration is handled separately (see ticket S4.1).");
  }

  // The env the wrapper sources: creds + how to invoke the tick CLI, plus the
  // model config only when full run is opted into.
  const env: Record<string, string> = { ...cfg.creds, FOUNDERSOS_TICK_BIN: cfg.tickBin };
  if (cfg.execute) {
    if (!env.FOUNDERSOS_AGENT_PROVIDER) env.FOUNDERSOS_AGENT_PROVIDER = DEFAULT_AGENT_PROVIDER;
    if (!env.FOUNDERSOS_AGENT_MODEL) env.FOUNDERSOS_AGENT_MODEL = DEFAULT_AGENT_MODEL;
  }

  const files: PlannedFile[] = [
    { path: cfg.paths.envFile, content: buildEnvFile(env), mode: 0o600 },
    { path: cfg.paths.wrapperUnix, content: WRAPPER_SH, mode: 0o755 },
  ];

  const schedOpts = {
    wrapperPathUnix: cfg.paths.wrapperUnix,
    logPath: cfg.paths.logFile,
    cadence: cfg.cadence,
    dailyHour: cfg.dailyHour,
  };

  if (cfg.scheduler === "launchd") {
    files.push({ path: cfg.units.launchdPlist, content: buildLaunchdPlist(schedOpts), mode: 0o644 });
  } else if (cfg.scheduler === "systemd") {
    files.push({ path: cfg.units.systemdService, content: buildSystemdService(schedOpts), mode: 0o644 });
    files.push({ path: cfg.units.systemdTimer, content: buildSystemdTimer(schedOpts), mode: 0o644 });
  }
  // cron writes no unit file; the crontab line is added by the register step.

  const cronLine = buildCronLine(schedOpts).trimEnd();
  const register = buildRegisterCommands({
    os: cfg.os,
    scheduler: cfg.scheduler,
    units: cfg.units,
    cronLine,
  });

  return { files, register, os: cfg.os, scheduler: cfg.scheduler };
}
