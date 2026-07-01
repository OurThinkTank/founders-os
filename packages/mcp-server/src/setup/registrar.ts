// ============================================================
// Founders OS — scheduler registration (the missing "register" step)
// ============================================================
// Generation already exists; the cliff is placing a unit and registering it
// with the OS (the launchctl/systemctl/crontab dance, and the ~-not-expanded
// and EX_CONFIG traps). The COMMAND BUILDERS here are pure and unit-tested;
// the exec + crontab merge are thin and defensive. Nothing here runs in CI
// (no launchd/systemd session), so the value is in asserting the plan.
// ============================================================

import { spawnSync } from "node:child_process";
import type { OsKind, Scheduler, UnitPaths } from "./paths.js";

export const CRON_TAG = "# founders-os-tick";
const LAUNCHD_LABEL = "com.foundersos.tick";
const SYSTEMD_TIMER = "foundersos-tick.timer";

export type Command =
  | { kind: "exec"; cmd: string; args: string[]; ignoreError?: boolean; desc: string }
  | { kind: "cron-add"; line: string; tag: string; desc: string };

export interface RegisterInput {
  os: OsKind;
  scheduler: Scheduler;
  units: UnitPaths;
  cronLine: string; // the bare crontab line (schedule + wrapper), no tag
}

/** Pure: the ordered commands that register a schedule. Idempotent by
 * construction (launchd unloads before loading; systemd re-enable is a no-op;
 * cron-add replaces any prior tagged line). */
export function buildRegisterCommands(input: RegisterInput): Command[] {
  const { scheduler, units } = input;

  if (scheduler === "launchd") {
    return [
      // Unload a prior copy first so re-running init does not error. load/unload
      // are used (not bootstrap) because they work across macOS versions without
      // computing a gui/<uid> domain target.
      { kind: "exec", cmd: "launchctl", args: ["unload", units.launchdPlist], ignoreError: true, desc: "unload any existing agent" },
      { kind: "exec", cmd: "launchctl", args: ["load", "-w", units.launchdPlist], ignoreError: false, desc: "load and enable the agent" },
    ];
  }

  if (scheduler === "systemd") {
    return [
      { kind: "exec", cmd: "systemctl", args: ["--user", "daemon-reload"], ignoreError: false, desc: "reload user units" },
      { kind: "exec", cmd: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_TIMER], ignoreError: false, desc: "enable and start the timer" },
    ];
  }

  // cron: merge one tagged line into the user's crontab.
  return [{ kind: "cron-add", line: input.cronLine, tag: CRON_TAG, desc: "add the tick line to your crontab" }];
}

// ── crontab merge (pure core + thin IO) ─────────────────────
// Replace any prior tagged line, else append. Keeps exactly one tick line.
export function mergeCrontab(existing: string, line: string, tag: string): string {
  const tagged = `${line} ${tag}`;
  const kept = existing
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.includes(tag));
  kept.push(tagged);
  return kept.join("\n") + "\n";
}

export function readCrontab(): string {
  const r = spawnSync("crontab", ["-l"], { encoding: "utf-8" });
  // A user with no crontab yet returns non-zero with "no crontab for ..." —
  // treat that as empty, not an error.
  if (r.status === 0) return r.stdout || "";
  return "";
}

export function writeCrontab(content: string): { ok: boolean; error?: string } {
  const r = spawnSync("crontab", ["-"], { input: content, encoding: "utf-8" });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || `crontab exited ${r.status}`).trim() };
}

export interface CommandResult {
  desc: string;
  ok: boolean;
  detail?: string;
}

/** Execute a register plan. Thin and defensive: a command marked ignoreError
 * never fails the run; a cron-add reads/merges/writes the crontab. */
export function runCommands(cmds: Command[]): CommandResult[] {
  const results: CommandResult[] = [];
  for (const c of cmds) {
    if (c.kind === "cron-add") {
      const merged = mergeCrontab(readCrontab(), c.line, c.tag);
      const w = writeCrontab(merged);
      results.push({ desc: c.desc, ok: w.ok, detail: w.error });
      continue;
    }
    const r = spawnSync(c.cmd, c.args, { encoding: "utf-8" });
    const ok = c.ignoreError ? true : r.status === 0;
    const detail = r.status === 0 ? undefined : (r.stderr || r.error?.message || `exit ${r.status}`).trim();
    results.push({ desc: c.desc, ok, detail });
  }
  return results;
}

// ── status probe (doctor) ───────────────────────────────────
export interface ScheduleStatus {
  registered: boolean;
  detail: string;
}

export function parseLaunchctlList(stdout: string): boolean {
  // `launchctl list` prints one line per loaded job: "<pid>\t<status>\t<label>".
  return stdout.split("\n").some((l) => l.includes(LAUNCHD_LABEL));
}

export function parseSystemctlEnabled(stdout: string, status: number): boolean {
  // `systemctl --user is-enabled <timer>` prints "enabled" (exit 0) when on.
  return status === 0 && stdout.trim().startsWith("enabled");
}

export function crontabHasTag(existing: string, tag: string): boolean {
  return existing.split("\n").some((l) => l.includes(tag));
}

export function scheduleStatus(os: OsKind, scheduler: Scheduler): ScheduleStatus {
  if (scheduler === "launchd") {
    const r = spawnSync("launchctl", ["list"], { encoding: "utf-8" });
    const registered = r.status === 0 && parseLaunchctlList(r.stdout || "");
    return { registered, detail: registered ? "launchd agent loaded" : "not loaded" };
  }
  if (scheduler === "systemd") {
    const r = spawnSync("systemctl", ["--user", "is-enabled", SYSTEMD_TIMER], { encoding: "utf-8" });
    const registered = parseSystemctlEnabled(r.stdout || "", r.status ?? 1);
    return { registered, detail: registered ? "systemd timer enabled" : "timer not enabled" };
  }
  const registered = crontabHasTag(readCrontab(), CRON_TAG);
  return { registered, detail: registered ? "cron line present" : "no cron line" };
}
