// ============================================================
// Founders OS — `founders-os-tick doctor`
// ============================================================
// A plain-language health screen a non-technical user can read: is the
// schedule registered, when did it last run and did it succeed, what model,
// is a connector wired. Closes the observability gap from the evaluation —
// the in-run counters are unreliable, so this reports VERIFIED state (the OS
// scheduler + the wrapper log), not loose summary lines.
//
// The auto-send tier lives in the server policy. doctor reads it live
// (best-effort): if creds are present it reports the real external_write tier
// and the paused kill switch; if the policy can't be read it degrades to a
// neutral line rather than failing, so doctor still works offline.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import { buildContext, governanceTools } from "@ourthinktank/founders-os-core";
import { detectOs, defaultScheduler, managedPaths, type ManagedPaths, type OsKind, type Scheduler } from "./paths.js";
import { scheduleStatus } from "./registrar.js";
import { checkTickBinResolves } from "./resolve.js";
import { parseEnvFile } from "./generators.js";
import { checkAgentSdk, AGENT_SDK_PKG, type SdkCheck } from "./sdk.js";
import { computePosture, renderPosture, type ScheduleMode } from "./posture.js";

// Re-export so existing importers keep resolving the type from here.
export type { ScheduleMode } from "./posture.js";

type PolicyShape = { tier_outcomes: Record<string, string>; paused?: boolean };
const getPolicy = governanceTools.get_policy.handler as unknown as (ctx: unknown, args: unknown) => Promise<{ policy: PolicyShape }>;

export interface AutosendState {
  known: boolean; // false when the policy couldn't be read (no creds / offline)
  on?: boolean; // external writes may auto-dispatch (tier != hold)
  tier?: string; // the resolved external_write outcome
  paused?: boolean; // company-wide kill switch
}

/** Read the live external_write tier, best-effort. Never throws: a missing
 * creds / unreachable DB yields { known: false } so doctor still runs. */
export async function readAutosendState(): Promise<AutosendState> {
  try {
    const ctx = buildContext();
    const policy = (await getPolicy(ctx, {})).policy;
    const tier = policy.tier_outcomes.external_write;
    return { known: true, on: tier !== "hold_for_approval", tier, paused: Boolean(policy.paused) };
  } catch {
    return { known: false };
  }
}

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

export interface AutodispatchState {
  scheduleMode: ScheduleMode; // what the installed wrapper actually runs
  sdkInstalled: boolean;
  apiKey: boolean;
  ready: boolean; // full-run schedule + SDK + key all present
  label: string; // plain-language status
}

/** Pure: is the installed wrapper a full-run (execute) or hold-only one? The
 * body carries the run posture verbatim (`run --execute` vs `run --hold-only`),
 * so a substring is a reliable, dependency-free signal. */
export function readScheduleMode(wrapperBody: string): ScheduleMode {
  if (!wrapperBody) return "none";
  return wrapperBody.includes("run --execute") ? "execute" : "hold-only";
}

/** Pure: combine the schedule posture with the SDK/API-key readiness into the
 * one auto-dispatch status line: ready / SDK missing / no API key / hold-only. */
export function describeAutodispatch(scheduleMode: ScheduleMode, sdk: SdkCheck): AutodispatchState {
  let ready = false;
  let label: string;
  if (scheduleMode === "none") {
    label = "not set up (enable with: founders-os-tick init --execute)";
  } else if (scheduleMode === "hold-only") {
    label = "schedule is hold-only; stages only (turn on with: founders-os-tick autosend slack --on)";
  } else if (!sdk.sdkInstalled) {
    label = `SDK didn't resolve; reinstall @ourthinktank/founders-os (${AGENT_SDK_PKG} ships with it)`;
  } else if (!sdk.apiKey) {
    label = `no ${sdk.apiKeyVar}; set it in the environment or the tick env file`;
  } else {
    ready = true;
    label = "ready: full-run schedule, Agent SDK and API key all in place";
  }
  return { scheduleMode, sdkInstalled: sdk.sdkInstalled, apiKey: sdk.apiKey, ready, label };
}

/** Read the installed wrapper body for the platform, empty string if absent. */
function readWrapperBody(paths: ManagedPaths, os: OsKind): string {
  const p = os === "windows" ? paths.wrapperWin : paths.wrapperUnix;
  return readFileSafe(p);
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

export async function runDoctor(a: DoctorArgs): Promise<number> {
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
  const tickBin = readEnvValue(envText, "FOUNDERSOS_TICK_BIN");
  const connectorConfigured = existsSync(paths.connectorsFile);
  const autosend = await readAutosendState();

  // Auto-dispatch readiness: what the wrapper actually runs, plus whether the
  // full-run runner could start. The scheduled job sources the env FILE (not
  // this shell), so merge it in before checking the provider + API key.
  const scheduleMode = readScheduleMode(readWrapperBody(paths, os));
  const sdk = checkAgentSdk({ ...process.env, ...parseEnvFile(envText) });
  const autodispatch = describeAutodispatch(scheduleMode, sdk);

  // The plain-language posture ladder: the single what/why/how/done answer,
  // computed once and reused by init and autosend too.
  const posture = computePosture({
    scheduleRegistered: sched.registered,
    scheduleMode,
    autosendOn: autosend.known ? Boolean(autosend.on) : false,
    tierKnown: autosend.known,
    connectorConfigured,
    sdk,
    paused: Boolean(autosend.paused),
  });

  // CLI reachability: a successful last run already proves the scheduled bin
  // resolves, so only probe (which can be slow for the npx form) when there
  // has never been a run.
  let cli: { reachable: boolean | null; detail: string };
  if (lastRun) {
    cli = lastRun.ok
      ? { reachable: true, detail: "last scheduled run succeeded" }
      : { reachable: null, detail: "last run failed — see Last run above" };
  } else if (tickBin) {
    const c = checkTickBinResolves(tickBin);
    cli = { reachable: c.ok, detail: c.detail };
  } else {
    cli = { reachable: null, detail: "not configured yet (run init)" };
  }

  const report = {
    schedule: { registered: sched.registered, scheduler, detail: sched.detail },
    last_run: lastRun,
    cli,
    autosend,
    autodispatch,
    posture: { rung: posture.rung, title: posture.title, healthy: posture.healthy, blockers: posture.blockers, next_step: posture.nextStep ?? null },
    model: model ?? null,
    connector_configured: connectorConfigured,
    config_dir: paths.configDir,
  };

  if (a.json) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return EXIT_OK;
  }

  const healthy = sched.registered && (lastRun ? lastRun.ok : true) && cli.reachable !== false;
  process.stdout.write(`founders-os-tick doctor — ${healthy ? "healthy" : "needs attention"}\n`);
  process.stdout.write(`  Schedule:   ${sched.registered ? `registered (${scheduler})` : "NOT registered — run: founders-os-tick init"}\n`);
  if (lastRun) {
    process.stdout.write(`  Last run:   ${lastRun.at} — ${lastRun.ok ? "succeeded" : `failed (${lastRun.detail})`}\n`);
  } else {
    process.stdout.write(`  Last run:   never (waiting for the first scheduled tick)\n`);
  }
  const cliLabel = cli.reachable === true ? "reachable" : cli.reachable === false ? "NOT reachable — the hourly job may fail" : "unverified";
  process.stdout.write(`  CLI:        ${cliLabel} (${cli.detail})\n`);
  process.stdout.write(`  Connector:  ${connectorConfigured ? "Slack configured" : "none yet"}\n`);
  process.stdout.write(`  Model:      ${model ?? "not set (Preparing needs none)"}\n`);

  // The posture ladder: what you're doing, the three rungs with you marked,
  // whether it's working, and the exact next step.
  process.stdout.write("\n" + renderPosture(posture));
  process.stdout.write(`\n  Review what fired: open Founders OS and ask "what fired?"\n`);
  return EXIT_OK;
}
