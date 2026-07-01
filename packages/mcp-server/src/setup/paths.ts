// ============================================================
// Founders OS — setup paths + OS detection
// ============================================================
// Single source for where the tool keeps its managed files. Everything the
// wizard owns lives under ONE directory (~/.config/founders-os by default,
// overridable via FOUNDERSOS_CONFIG_DIR for tests), so a user never sets a
// FOUNDERSOS_* variable by hand and tests can point HOME/config at a tmpdir.
// ============================================================

import { homedir } from "node:os";
import { join } from "node:path";

export type OsKind = "macos" | "linux" | "windows";
export type Scheduler = "launchd" | "systemd" | "cron" | "taskscheduler";

export function detectOs(platform: string = process.platform): OsKind {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/** The single managed config directory. FOUNDERSOS_CONFIG_DIR overrides. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOUNDERSOS_CONFIG_DIR || join(homedir(), ".config", "founders-os");
}

export interface ManagedPaths {
  configDir: string;
  envFile: string; // creds sourced by the wrapper
  wrapperUnix: string; // foundersos-tick.sh
  wrapperWin: string; // foundersos-tick.cmd
  policyFile: string; // connector policy (written by connect/autosend)
  connectorsFile: string; // runner-connectors.json (written by connect)
  logFile: string; // wrapper log
}

export function managedPaths(env: NodeJS.ProcessEnv = process.env): ManagedPaths {
  const dir = configDir(env);
  return {
    configDir: dir,
    envFile: join(dir, "foundersos-tick.env"),
    wrapperUnix: join(dir, "foundersos-tick.sh"),
    wrapperWin: join(dir, "foundersos-tick.cmd"),
    policyFile: join(dir, "connector-policy.json"),
    connectorsFile: join(dir, "runner-connectors.json"),
    logFile: join(homedir(), ".local", "state", "foundersos-tick.log"),
  };
}

/** Where the scheduler unit files live per OS (user scope, no root). */
export interface UnitPaths {
  launchdPlist: string; // macOS
  systemdService: string; // Linux
  systemdTimer: string; // Linux
}

export function unitPaths(env: NodeJS.ProcessEnv = process.env): UnitPaths {
  const home = env.HOME || homedir();
  return {
    launchdPlist: join(home, "Library", "LaunchAgents", "com.foundersos.tick.plist"),
    systemdService: join(home, ".config", "systemd", "user", "foundersos-tick.service"),
    systemdTimer: join(home, ".config", "systemd", "user", "foundersos-tick.timer"),
  };
}

/** The default scheduler for an OS. cron is the Linux fallback when the user
 * has no systemd user session. */
export function defaultScheduler(os: OsKind): Scheduler {
  if (os === "macos") return "launchd";
  if (os === "windows") return "taskscheduler";
  return "systemd"; // linux
}
