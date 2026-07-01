// ============================================================
// Founders OS — `founders-os-tick doctor`
// ============================================================
// A plain-language health screen a non-technical user can read: is the
// schedule registered, when did it last run and did it succeed, what model,
// is a connector wired. Closes the observability gap from the evaluation —
// the in-run counters are unreliable, so this reports VERIFIED state (the OS
// scheduler + the wrapper log), not loose summary lines.
//
// Note (S1 scope): the auto-send tier lives in the server policy, wired in
// with S3.6 (autosend). For now doctor reports local install health and
// whether a connector is configured; it does not assert the policy tier.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import { detectOs, defaultScheduler, managedPaths, type Scheduler } from "./paths.js";
import { scheduleStatus } from "./registrar.js";

const EXIT_OK = 0;

export interface DoctorArgs {
  json: boolean;
}

export interface LastRun {
  at: string;
  ok: boolean;
  detail: string;
}

/** Pure: parse the wrapper log for the most recent completed run. The wrapper
 * writes "<iso-ts> [tick-wrapper] done (detect=<rc> run=<rc>)". */
export function parseLastRun(logText: string): LastRun | null {
  const lines = logText.split("\n").filter((l) => l.includes("[tick-wrapper] done"));
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const at = last.split(/\s+/)[0] || "";
  const m = last.match(/detect=(\d+)\s+run=(\d+)/);
  const detectRc = m ? Number(m[1]) : null;
  const runRc = m ? Number(m[2]) : null;
  const ok = detectRc === 0 && runRc === 0;
  const detail = m ? `detect=${detectRc} run=${runRc}` : "unparsed";
  return { at, ok, detail };
}

/** Pure: read a KEY=value from an env-file body, unquoting a quoted value. */
export function readEnvValue(envText: string, key: string): string | undefined {
  for (const raw of envText.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    if (line.slice(0, eq) !== key) continue;
    let v = line.slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, "$1");
    return v;
  }
  return undefined;
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

export function runDoctor(a: DoctorArgs): number {
  const os = detectOs();
  const paths = managedPaths();

  // Schedule: check the OS default; fall back to checking cron too.
  let scheduler: Scheduler = defaultScheduler(os);
  let sched = scheduleStatus(os, scheduler);
  if (!sched.registered && scheduler !== "cron") {
    const cron = scheduleStatus(os, "cron");
    if (cron.registered) {
      scheduler = "cron";
      sched = cron;
    }
  }

  const lastRun = parseLastRun(readFileSafe(paths.logFile));
  const envText = readFileSafe(paths.envFile);
  const model = readEnvValue(envText, "FOUNDERSOS_AGENT_MODEL");
  const connectorConfigured = existsSync(paths.connectorsFile);

  const report = {
    schedule: { registered: sched.registered, scheduler, detail: sched.detail },
    last_run: lastRun,
    model: model ?? null,
    connector_configured: connectorConfigured,
    config_dir: paths.configDir,
  };

  if (a.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return EXIT_OK;
  }

  const healthy = sched.registered && (lastRun ? lastRun.ok : true);
  process.stdout.write(`founders-os-tick doctor — ${healthy ? "healthy" : "needs attention"}\n`);
  process.stdout.write(`  Schedule:   ${sched.registered ? `registered (${scheduler})` : "NOT registered — run: founders-os-tick init"}\n`);
  if (lastRun) {
    process.stdout.write(`  Last run:   ${lastRun.at} — ${lastRun.ok ? "succeeded" : `failed (${lastRun.detail})`}\n`);
  } else {
    process.stdout.write(`  Last run:   never (waiting for the first scheduled tick)\n`);
  }
  process.stdout.write(`  Auto-send:  off — everything waits for you (turn on later with autosend)\n`);
  process.stdout.write(`  Connector:  ${connectorConfigured ? "Slack configured" : "none yet"}\n`);
  process.stdout.write(`  Model:      ${model ?? "not set (hold-only needs none)"}\n`);
  process.stdout.write(`\n  Pause everything:  founders-os-tick run is paused via pause_agents in a session.\n`);
  process.stdout.write(`  Review what fired: open Founders OS and ask "what fired?"\n`);
  return EXIT_OK;
}
