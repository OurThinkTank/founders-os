#!/usr/bin/env node

// ============================================================
// Founders OS — tick CLI (the local scheduler entry point)
// ============================================================
// A one-shot command an OS scheduler (launchd / systemd / Task
// Scheduler) runs on a cadence to give triggers a clock. See
// proposals/tick-cli-plan.md.
//
//   founders-os-tick detect [--conditions=a,b] [--dry] [--json] [--quiet]
//
// `detect` runs ONLY the data-condition evaluators — no model, no
// connectors, no actions performed. It fire-claims (deduped) and upserts
// each fire into the trigger_fires inbox so the next interactive session
// can drain it (list_trigger_fires). Connector conditions are skipped:
// they need a session. `run` (unattended agent that drains + acts) is
// Phase 2 and not built yet.
//
// Config is entirely env, identical to the stdio server: SUPABASE_URL,
// SUPABASE_SECRET_KEY, and the FOUNDERS_OS_* identity vars. Exit code 0
// on a clean tick (even if nothing fired); non-zero on a config or
// database failure so a scheduler can alert on real problems.
// ============================================================

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildContext,
  buildAutonomousContext,
  evaluateDataTriggers,
  runHoldOnly,
  runFull,
  readAgentModelConfigFromEnv,
  buildRunnerMcpServers,
  runnerAllowedTools,
  runAgentSession,
  RUNNER_SYSTEM_PROMPT,
  RUNNER_USER_PROMPT,
} from "@ourthinktank/founders-os-core";
import {
  selectRunner,
  collectServerEnv,
  foundersOsLaunch,
  loadRunnerConnectors,
  loadConnectorPolicy,
  defaultRunQuery,
} from "./agent-runner.js";
import { runInit } from "./setup/init.js";
import { runDoctor } from "./setup/doctor.js";

// Exit codes: 0 clean, 1 config/runtime failure, 2 usage error.
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

interface Args {
  command: string;
  json: boolean;
  dry: boolean;
  quiet: boolean;
  holdOnly: boolean;
  execute: boolean;
  conditions?: string[];
  // init options
  yes: boolean;
  cron: boolean;
  cadence?: "hourly" | "daily";
  hour?: number;
  tickBin?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", json: false, dry: false, quiet: false, holdOnly: false, execute: false, yes: false, cron: false };
  for (const a of argv.slice(1)) {
    if (a === "--json") args.json = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--hold-only") args.holdOnly = true;
    else if (a === "--execute") args.execute = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--cron") args.cron = true;
    else if (a === "--daily") args.cadence = "daily";
    else if (a.startsWith("--cadence=")) {
      const c = a.slice("--cadence=".length);
      if (c === "hourly" || c === "daily") args.cadence = c;
    } else if (a.startsWith("--hour=")) {
      args.hour = Number(a.slice("--hour=".length));
    } else if (a.startsWith("--tick-bin=")) {
      args.tickBin = a.slice("--tick-bin=".length);
    } else if (a.startsWith("--conditions=")) {
      args.conditions = a.slice("--conditions=".length).split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return args;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(resolve(here, "..", "package.json"), "utf-8"));
    return String(pkg.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

const USAGE = `founders-os-tick — local scheduler for Founders OS triggers

Usage:
  founders-os-tick init [options]        Guided setup: schedule the overnight check (no files to edit)
  founders-os-tick doctor [--json]       Show status: schedule, last run, model, connector
  founders-os-tick detect [options]      Run data-condition detection, write the inbox
  founders-os-tick run --hold-only [opts] Drain the inbox: stage every fire for human review, perform nothing
  founders-os-tick run --execute [opts]   Model-driven full run (detect + withhold + record + reconcile)
  founders-os-tick --version
  founders-os-tick --help

init options:
  --yes / -y         Non-interactive: accept defaults (hourly, OS default scheduler)
  --cadence=hourly|daily  Check cadence (default hourly). --daily is shorthand for daily.
  --hour=N           Hour of day for a daily cadence (default 6)
  --cron             Use cron instead of the OS default (launchd on macOS, systemd on Linux)
  --tick-bin=CMD     How the wrapper invokes the CLI (default: an npx form)

detect options:
  --conditions=a,b   Restrict to these condition_types (default: all enabled)
  --dry              Evaluate without claiming or writing anything
  --json             Emit one machine-readable summary line
  --quiet            Suppress the human summary line

run options:
  --hold-only        Stage every inbox fire into the approval queue for a human
                     to approve/edit/reject; never sends or performs anything.
  --execute          Model-driven full run: a model reads each fire and creates
                     internal follow-ups (tasks, notifications) or stages
                     external actions for approval. Uses the Agent SDK runner by
                     default (needs ANTHROPIC_API_KEY); set
                     FOUNDERSOS_TICK_RUNNER=inprocess for the frozen fallback
                     loop (needs FOUNDERSOS_AGENT_PROVIDER, OpenAI-capable).
                     Equivalent to FOUNDERSOS_TICK_RUN_MODE=full. It does NOT
                     auto-send external actions yet: externals stage for a human
                     to approve.
  --json / --quiet   As above.`;

async function runDetect(args: Args): Promise<number> {
  let ctx;
  try {
    ctx = buildContext();
  } catch (e) {
    process.stderr.write(`[tick] config error: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }

  try {
    const res = await evaluateDataTriggers(ctx, {
      conditionTypes: args.conditions,
      dryEvaluate: args.dry,
      // A dry run writes nothing; otherwise detect populates the inbox.
      writeInbox: !args.dry,
    });

    const summary = {
      mode: args.dry ? "detect:dry" : "detect",
      evaluated: res.evaluated,
      fired: res.fired.length,
      connector_waiting: res.connectorTriggers.length,
      errors: res.errors.length,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(summary) + "\n");
    } else if (!args.quiet) {
      const parts = [`evaluated ${summary.evaluated}`, `fired ${summary.fired}`];
      if (summary.connector_waiting) parts.push(`${summary.connector_waiting} connector watch(es) waiting for a session`);
      if (summary.errors) parts.push(`${summary.errors} error(s)`);
      process.stdout.write(`[tick] ${summary.mode}: ${parts.join(", ")}\n`);
      for (const f of res.fired) process.stdout.write(`  • ${f.name}: ${f.brief}\n`);
    }

    // Per-trigger failures are isolated (one bad watch does not fail the
    // tick); surface them on stderr so a human running it sees them.
    for (const e of res.errors) {
      process.stderr.write(`[tick] trigger "${e.name}" (${e.trigger_id}): ${e.error}\n`);
    }

    return EXIT_OK;
  } catch (e) {
    process.stderr.write(`[tick] detect failed: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }
}

/**
 * Dispatch `run` to the right mode. A full run (--execute or
 * FOUNDERSOS_TICK_RUN_MODE=full) goes to the Agent SDK runner by default, or
 * the frozen Phase 2b in-process loop when FOUNDERSOS_TICK_RUNNER=inprocess.
 * Otherwise --hold-only stages everything; bare `run` is refused.
 */
async function runRun(args: Args): Promise<number> {
  const choice = selectRunner({
    execute: args.execute,
    holdOnly: args.holdOnly,
    runMode: process.env.FOUNDERSOS_TICK_RUN_MODE,
    runner: process.env.FOUNDERSOS_TICK_RUNNER,
  });

  if (choice === "agent-sdk") return runAgentSdkMode(args);

  if (choice === "inprocess") {
    // The in-process fallback drives the model itself, so it still needs the
    // FOUNDERSOS_AGENT_* model config (the Agent SDK path reads its own key).
    const agentConfig = readAgentModelConfigFromEnv();
    if (!agentConfig) {
      process.stderr.write(
        "[tick] the in-process fallback runner (FOUNDERSOS_TICK_RUNNER=inprocess) needs an agent model. " +
          "Set FOUNDERSOS_AGENT_PROVIDER (+ FOUNDERSOS_AGENT_MODEL + an API key), or unset " +
          "FOUNDERSOS_TICK_RUNNER to use the Agent SDK runner.\n"
      );
      return EXIT_FAIL;
    }
    return runFullMode(args);
  }

  if (choice === "hold-only") return runHold(args);

  // refuse: bare `run` with no posture.
  process.stderr.write(
    "[tick] run requires --execute (Agent SDK runner; needs ANTHROPIC_API_KEY) or --hold-only " +
      "(stage everything, perform nothing).\n"
  );
  return EXIT_USAGE;
}

/**
 * The Agent SDK runner (Option B, primary). It launches the founders-os MCP
 * server in autonomous mode plus any configured connectors and drives a model
 * session that drains the inbox. runAgentSession applies the pause check, the
 * run lock, and the send budget; a connector write is performed only when its
 * verb + scope are enabled by the policy AND it consumes a fresh clearance. An
 * empty policy denies every connector, so externals stage for human approval.
 * The autonomous hookCtx is for the verify-clearance hook's DB access.
 */
async function runAgentSdkMode(args: Args): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    process.stderr.write(
      "[tick] the Agent SDK runner needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). " +
        "For an OpenAI-capable run, set FOUNDERSOS_TICK_RUNNER=inprocess with FOUNDERSOS_AGENT_PROVIDER, " +
        "or point ANTHROPIC_BASE_URL at a LiteLLM proxy.\n"
    );
    return EXIT_FAIL;
  }

  const runId = randomUUID();
  let mcpServers;
  let hookCtx;
  let connectorPolicy;
  try {
    const launch = foundersOsLaunch();
    mcpServers = buildRunnerMcpServers({
      runId,
      serverCommand: launch.command,
      serverArgs: launch.args,
      serverEnv: collectServerEnv(),
      connectors: loadRunnerConnectors(),
    });
    // Per-connector auto-dispatch policy (verbs + scopes). Empty by default,
    // so every connector is denied at the hook until explicitly enabled.
    connectorPolicy = loadConnectorPolicy();
    // The verify-clearance hook needs DB access; build an autonomous context
    // for it (it reads/writes the same action_clearances the founders-os
    // subprocess writes via execute_action).
    hookCtx = buildAutonomousContext(runId);
  } catch (e) {
    process.stderr.write(`[tick] runner config error: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }

  const maxTurnsRaw = process.env.FOUNDERSOS_AGENT_MAX_TURNS;
  const maxSendsRaw = process.env.FOUNDERSOS_AGENT_MAX_SENDS;

  try {
    // runAgentSession owns the pause check, the per-company run lock, and the
    // send budget; a connector write needs its verb + scope enabled by the
    // policy (T2.3) AND a fresh clearance (T2.2). Empty policy => stage-only.
    const res = await runAgentSession(
      hookCtx,
      {
        mcpServers,
        allowedTools: runnerAllowedTools(),
        systemPrompt: RUNNER_SYSTEM_PROMPT,
        prompt: RUNNER_USER_PROMPT,
        model: process.env.FOUNDERSOS_AGENT_MODEL,
        maxTurns: maxTurnsRaw ? Number(maxTurnsRaw) : 40,
        maxSends: maxSendsRaw ? Number(maxSendsRaw) : undefined,
        policy: connectorPolicy,
      },
      defaultRunQuery
    );

    const out = {
      mode: "run:agent-sdk",
      run_id: runId,
      paused: res.paused,
      locked_out: res.locked_out,
      sent: res.sent,
      created: res.created,
      staged: res.staged,
      resolved: res.resolved,
      budget_exhausted: res.budget_exhausted,
      errors: res.errors,
    };
    if (args.json) {
      process.stdout.write(JSON.stringify(out) + "\n");
    } else if (!args.quiet) {
      if (res.paused) {
        process.stdout.write("[tick] run:agent-sdk: agents are paused company-wide; nothing processed.\n");
      } else if (res.locked_out) {
        process.stdout.write("[tick] run:agent-sdk: another run holds the lock; nothing processed.\n");
      } else {
        const parts = [
          `sent ${res.sent}`,
          `created ${res.created}`,
          `staged ${res.staged} for review`,
          `resolved ${res.resolved}`,
        ];
        if (res.budget_exhausted) parts.push("send budget exhausted");
        if (res.errors) parts.push(`${res.errors} tool error(s)`);
        process.stdout.write(`[tick] run:agent-sdk: ${parts.join(", ")}\n`);
      }
    }
    return EXIT_OK;
  } catch (e) {
    process.stderr.write(`[tick] agent-sdk run failed: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }
}

async function runFullMode(args: Args): Promise<number> {
  const runId = randomUUID();
  let ctx;
  try {
    ctx = buildAutonomousContext(runId);
  } catch (e) {
    process.stderr.write(`[tick] config error: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }

  try {
    const res = await runFull(ctx);
    const summary = {
      mode: "run:full",
      run_id: runId,
      paused: res.paused,
      locked_out: res.locked_out,
      scanned: res.scanned,
      created: res.created,
      staged: res.staged,
      skipped: res.skipped,
      budget_exhausted: res.budget_exhausted,
      errors: res.errors.length,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(summary) + "\n");
    } else if (!args.quiet) {
      if (res.paused) {
        process.stdout.write("[tick] run:full: agents are paused company-wide; nothing processed.\n");
      } else if (res.locked_out) {
        process.stdout.write("[tick] run:full: another run holds the lock; nothing processed.\n");
      } else {
        const parts = [
          `scanned ${summary.scanned}`,
          `created ${summary.created}`,
          `staged ${summary.staged} for review`,
        ];
        if (summary.skipped) parts.push(`${summary.skipped} skipped`);
        if (summary.budget_exhausted) parts.push("action budget exhausted");
        if (summary.errors) parts.push(`${summary.errors} error(s)`);
        process.stdout.write(`[tick] run:full: ${parts.join(", ")}\n`);
      }
    }

    for (const e of res.errors) {
      process.stderr.write(`[tick] fire ${e.fire_id}: ${e.error}\n`);
    }
    return EXIT_OK;
  } catch (e) {
    process.stderr.write(`[tick] run failed: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }
}

async function runHold(args: Args): Promise<number> {
  // The model-free posture: stage everything, perform nothing. Enforced here
  // AND by the server (an autonomous principal can never clear a hold), so it
  // is not a flag an operator can flip to "send".
  if (!args.holdOnly) {
    process.stderr.write(
      "[tick] run requires --hold-only (stage everything, perform nothing) or --execute " +
        "(model-driven full run; needs FOUNDERSOS_AGENT_PROVIDER configured).\n"
    );
    return EXIT_USAGE;
  }

  const runId = randomUUID();
  let ctx;
  try {
    ctx = buildAutonomousContext(runId);
  } catch (e) {
    process.stderr.write(`[tick] config error: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }

  try {
    const res = await runHoldOnly(ctx);
    const summary = {
      mode: "run:hold-only",
      run_id: runId,
      paused: res.paused,
      scanned: res.scanned,
      staged: res.staged,
      skipped: res.skipped,
      errors: res.errors.length,
    };

    if (args.json) {
      process.stdout.write(JSON.stringify(summary) + "\n");
    } else if (!args.quiet) {
      if (res.paused) {
        process.stdout.write("[tick] run:hold-only: agents are paused company-wide; nothing processed.\n");
      } else {
        const parts = [`scanned ${summary.scanned}`, `staged ${summary.staged} for review`];
        if (summary.skipped) parts.push(`${summary.skipped} skipped`);
        if (summary.errors) parts.push(`${summary.errors} error(s)`);
        process.stdout.write(`[tick] run:hold-only: ${parts.join(", ")} (performed nothing)\n`);
      }
    }

    for (const e of res.errors) {
      process.stderr.write(`[tick] fire ${e.fire_id}: ${e.error}\n`);
    }
    return EXIT_OK;
  } catch (e) {
    process.stderr.write(`[tick] run failed: ${errMessage(e)}\n`);
    return EXIT_FAIL;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "--version" || args.command === "-v") {
    process.stdout.write((await readVersion()) + "\n");
    return EXIT_OK;
  }
  if (args.command === "" || args.command === "--help" || args.command === "-h") {
    process.stdout.write(USAGE + "\n");
    return args.command === "" ? EXIT_USAGE : EXIT_OK;
  }
  if (args.command === "init") {
    return runInit({ yes: args.yes, cadence: args.cadence, hour: args.hour, cron: args.cron, tickBin: args.tickBin });
  }
  if (args.command === "doctor") {
    return runDoctor({ json: args.json });
  }
  if (args.command === "detect") {
    return runDetect(args);
  }
  if (args.command === "run") {
    return runRun(args);
  }

  process.stderr.write(`[tick] unknown command "${args.command}".\n\n${USAGE}\n`);
  return EXIT_USAGE;
}

main().then((code) => process.exit(code));
