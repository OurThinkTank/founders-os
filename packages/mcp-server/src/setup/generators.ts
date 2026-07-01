// ============================================================
// Founders OS — setup generators (packaged TS copy)
// ============================================================
// `founders-os-tick init` runs from the INSTALLED npm package, where only
// `dist` ships (see package.json "files"). The canonical browser generators
// at integrations/setup-page/lib/setup-generators.js and the wrapper scripts
// at integrations/scheduler/*.{sh,cmd} are NOT part of the package, so init
// cannot read them at runtime. This module is the packaged copy of exactly
// the pieces init needs: the scheduler unit builders and the tick wrapper
// bodies.
//
// DRIFT GUARD: setup-generators.parity.test.ts asserts that (a) these unit
// builders produce byte-identical output to the canonical JS for the same
// opts, and (b) WRAPPER_SH / WRAPPER_CMD match integrations/scheduler/*
// verbatim. If either drifts the test fails, so this copy can never silently
// diverge. This mirrors the existing wrapper-body parity check on the JS side.
// ============================================================

export type Cadence = "hourly" | "daily";

export interface SchedulerOpts {
  label: string;
  wrapperPathUnix: string;
  wrapperPathWin: string;
  envPath: string;
  logPath: string;
  cadence: Cadence;
  dailyHour: number;
  taskName: string;
}

// ABSOLUTE on purpose: launchd and systemd do NOT expand "~", so a tilde path
// silently fails to launch (launchd exits 78/EX_CONFIG). init always resolves
// a real absolute path; these placeholders are loud fallbacks, never a
// working-but-wrong default.
export const DEFAULTS: SchedulerOpts = {
  label: "com.foundersos.tick",
  wrapperPathUnix: "/ABSOLUTE/PATH/TO/foundersos-tick.sh",
  wrapperPathWin: "%USERPROFILE%\\foundersos-tick.cmd",
  envPath: "~/.config/founders-os/foundersos-tick.env",
  logPath: "/tmp/foundersos-tick.log",
  cadence: "hourly",
  dailyHour: 6,
  taskName: "FoundersOS Tick",
};

export function withDefaults(opts?: Partial<SchedulerOpts>): SchedulerOpts {
  if (!opts) return { ...DEFAULTS };
  const overrides = Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null && v !== ""));
  return { ...DEFAULTS, ...overrides } as SchedulerOpts;
}

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}
function cronExpr(o: SchedulerOpts): string {
  return o.cadence === "daily" ? "0 " + o.dailyHour + " * * *" : "0 * * * *";
}
function systemdOnCalendar(o: SchedulerOpts): string {
  return o.cadence === "daily" ? "*-*-* " + pad2(o.dailyHour) + ":00:00" : "hourly";
}

// ── launchd (macOS) — points at the wrapper ─────────────────
export function buildLaunchdPlist(opts?: Partial<SchedulerOpts>): string {
  const o = withDefaults(opts);
  const interval =
    o.cadence === "daily"
      ? "<dict><key>Hour</key><integer>" + o.dailyHour + "</integer><key>Minute</key><integer>0</integer></dict>"
      : "<dict><key>Minute</key><integer>0</integer></dict>";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>" + o.label + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>" + o.wrapperPathUnix + "</string>",
    "  </array>",
    "  <key>StartCalendarInterval</key>" + interval,
    "  <key>StandardErrorPath</key><string>" + o.logPath + "</string>",
    "  <key>StandardOutPath</key><string>" + o.logPath + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

// ── systemd (Linux) — service + timer, points at the wrapper ─
export function buildSystemdService(opts?: Partial<SchedulerOpts>): string {
  const o = withDefaults(opts);
  return ["[Unit]", "Description=Founders OS tick (detect + run --hold-only)", "", "[Service]", "Type=oneshot", "ExecStart=" + o.wrapperPathUnix, ""].join(
    "\n"
  );
}
export function buildSystemdTimer(opts?: Partial<SchedulerOpts>): string {
  const o = withDefaults(opts);
  return [
    "[Unit]",
    "Description=Schedule the Founders OS tick",
    "",
    "[Timer]",
    "OnCalendar=" + systemdOnCalendar(o),
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// ── cron (Linux/macOS) — one line at the wrapper ────────────
export function buildCronLine(opts?: Partial<SchedulerOpts>): string {
  const o = withDefaults(opts);
  return cronExpr(o) + " " + o.wrapperPathUnix + " >> " + o.logPath + " 2>&1\n";
}

// ── Task Scheduler (Windows) — registers the .cmd wrapper ────
export function buildTaskSchedulerCmd(opts?: Partial<SchedulerOpts>): string {
  const o = withDefaults(opts);
  const sched = o.cadence === "daily" ? "/SC DAILY /ST " + pad2(o.dailyHour) + ":00" : "/SC HOURLY";
  return [
    "REM Register the Founders OS tick with Windows Task Scheduler.",
    "REM Runs the wrapper .cmd, which sets creds and runs detect then run --hold-only.",
    'schtasks /Create /TN "' + o.taskName + '" /TR "' + o.wrapperPathWin + '" ' + sched + " /F",
    'schtasks /Query  /TN "' + o.taskName + '"',
    'schtasks /Run    /TN "' + o.taskName + '"',
    "",
  ].join("\n");
}

// ── Tick wrapper bodies (verbatim copies of integrations/scheduler/*) ──
// Kept byte-identical to the canonical files by the parity test. Do not
// hand-edit; if the canonical wrapper changes, re-copy and the test confirms.
export const WRAPPER_SH =
  "#!/usr/bin/env bash\n# ============================================================\n# Founders OS — tick wrapper (detect + run --hold-only)\n# ============================================================\n# One scheduled run = the check then the drain:\n#   1. founders-os-tick detect          fills the trigger_fires inbox\n#   2. founders-os-tick run --hold-only  stages every fire for human review\n# They run serially (detect finishes before run starts). Nothing is ever\n# performed — staged items wait in the approval queue for a human.\n#\n# Point your OS scheduler (launchd / systemd / cron) at THIS script instead\n# of the bare commands, so one job does both halves. See\n# founders-os-docs/guides/tick-cli-usage.md.\n#\n# Config (all optional, override via env or the env file):\n#   FOUNDERSOS_TICK_ENV   path to an env file with SUPABASE_URL /\n#                         SUPABASE_SECRET_KEY / FOUNDERS_OS_* (default\n#                         ~/.config/founders-os/foundersos-tick.env)\n#   FOUNDERSOS_TICK_BIN   how to invoke the tick CLI. Default\n#                         \"founders-os-tick\" assumes a GLOBAL install\n#                         (npm i -g @ourthinktank/founders-os). If you run\n#                         the package via npx instead, set this to the npx\n#                         form (the tick is the package's second bin):\n#                           npx -y -p @ourthinktank/founders-os@latest founders-os-tick\n#                         or, for local dev:\n#                           npx tsx /path/to/packages/mcp-server/src/tick.ts\n#                         It may be a multi-word command (paths must not\n#                         contain spaces).\n#   FOUNDERSOS_TICK_LOG   log file (default ~/.local/state/foundersos-tick.log)\n# ============================================================\n\nset -uo pipefail\n\nENV_FILE=\"${FOUNDERSOS_TICK_ENV:-$HOME/.config/founders-os/foundersos-tick.env}\"\nLOG_FILE=\"${FOUNDERSOS_TICK_LOG:-$HOME/.local/state/foundersos-tick.log}\"\n\nmkdir -p \"$(dirname \"$LOG_FILE\")\" 2>/dev/null || true\n\n# Load creds from the env file if present (scheduled jobs get a minimal\n# environment and do NOT inherit your shell profile). This is also where\n# FOUNDERSOS_TICK_BIN can be set, so resolve the command AFTER sourcing it.\nif [ -f \"$ENV_FILE\" ]; then\n  set -a\n  # shellcheck disable=SC1090\n  . \"$ENV_FILE\"\n  set +a\nfi\n\n# Scheduled jobs (launchd/systemd) start with a minimal PATH that usually\n# lacks node/npx, so an npx-based command would fail with \"command not found\".\n# Add the common install locations. nvm or other non-standard installs: set\n# PATH in the env file, or point FOUNDERSOS_TICK_BIN at an absolute npx path.\nexport PATH=\"/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH\"\n\n# FOUNDERSOS_TICK_BIN may be a multi-word command (a global binary, an npx\n# invocation, or a dev `npx tsx ...` command). Split it into argv. Paths\n# with spaces are not supported - use a global install or a symlink.\nread -r -a TICK_CMD <<< \"${FOUNDERSOS_TICK_BIN:-founders-os-tick}\"\n\nlog() { printf '%s %s\\n' \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \"$*\" | tee -a \"$LOG_FILE\" >&2; }\n\nlog \"[tick-wrapper] start\"\n\n# 1. Detect — fill the inbox.\n\"${TICK_CMD[@]}\" detect --json | tee -a \"$LOG_FILE\"\nrc_detect=${PIPESTATUS[0]}\n\n# 2. Drain — stage whatever is pending. Runs even if detect failed, since the\n#    runner stages any inbox items that are already waiting.\n\"${TICK_CMD[@]}\" run --hold-only --json | tee -a \"$LOG_FILE\"\nrc_run=${PIPESTATUS[0]}\n\nlog \"[tick-wrapper] done (detect=$rc_detect run=$rc_run)\"\n\n# Exit non-zero if either step failed so the scheduler can alert.\n[ \"$rc_detect\" -eq 0 ] && [ \"$rc_run\" -eq 0 ]\n";

export const WRAPPER_CMD =
  '@echo off\nREM ============================================================\nREM Founders OS - tick wrapper (detect + run --hold-only)\nREM ============================================================\nREM One scheduled run = the check then the drain:\nREM   1. founders-os-tick detect           fills the trigger_fires inbox\nREM   2. founders-os-tick run --hold-only   stages every fire for human review\nREM They run serially. Nothing is performed - staged items wait for a human.\nREM Point Task Scheduler at THIS .cmd so one task does both halves.\nREM\nREM Set your credentials below, or rely on machine/user environment variables.\nREM ============================================================\n\nREM set "SUPABASE_URL=https://your-project.supabase.co"\nREM set "SUPABASE_SECRET_KEY=sb_secret_..."\n\nset "TICK=founders-os-tick"\nset "LOG=%USERPROFILE%\\foundersos-tick.log"\n\necho %date% %time% [tick-wrapper] start>> "%LOG%"\n\ncall %TICK% detect --json>> "%LOG%" 2>&1\nset "RC_DETECT=%ERRORLEVEL%"\n\ncall %TICK% run --hold-only --json>> "%LOG%" 2>&1\nset "RC_RUN=%ERRORLEVEL%"\n\necho %date% %time% [tick-wrapper] done detect=%RC_DETECT% run=%RC_RUN%>> "%LOG%"\n\nif not "%RC_DETECT%"=="0" exit /b 1\nif not "%RC_RUN%"=="0" exit /b 1\nexit /b 0\n';

// ── Env file for the scheduled wrapper ──────────────────────
// The wrapper `source`s this file, so a value with whitespace MUST be quoted
// (an unquoted `KEY=a b` is parsed as "run command b with KEY=a"). init owns
// the key set, so this is a focused writer, not the browser page's variant.
function envLine(k: string, v: string): string {
  let s = String(v);
  if (/\s/.test(s)) s = '"' + s.replace(/(["\\])/g, "\\$1") + '"';
  return k + "=" + s;
}

const ENV_ORDER = [
  "FOUNDERSOS_TICK_BIN",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "FOUNDERS_OS_COMPANY_ID",
  "FOUNDERS_OS_USER_ID",
  "FOUNDERS_OS_TIMEZONE",
  // Optional model config (only written when full run is opted into).
  "FOUNDERSOS_AGENT_PROVIDER",
  "FOUNDERSOS_AGENT_MODEL",
  "ANTHROPIC_API_KEY",
  // Auto-dispatch (written by connect/autosend, not init).
  "FOUNDERSOS_RUNNER_CONNECTORS",
  "FOUNDERSOS_CONNECTOR_POLICY_FILE",
];

export function buildEnvFile(env: Record<string, string>): string {
  const lines = [
    "# Founders OS tick credentials — loaded by foundersos-tick.sh/.cmd.",
    "# Keep this file private (chmod 600). Generated by `founders-os-tick init`.",
  ];
  const seen = new Set<string>();
  for (const k of ENV_ORDER) {
    seen.add(k);
    const v = env[k];
    if (v != null && v !== "") lines.push(envLine(k, v));
  }
  for (const k of Object.keys(env)) {
    if (!seen.has(k) && env[k] != null && env[k] !== "") lines.push(envLine(k, env[k]));
  }
  return lines.join("\n") + "\n";
}
