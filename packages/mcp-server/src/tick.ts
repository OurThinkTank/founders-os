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
import { buildContext, buildAutonomousContext, evaluateDataTriggers, runHoldOnly } from "@ourthinktank/founders-os-core";

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
  conditions?: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", json: false, dry: false, quiet: false, holdOnly: false };
  for (const a of argv.slice(1)) {
    if (a === "--json") args.json = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--hold-only") args.holdOnly = true;
    else if (a.startsWith("--conditions=")) {
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
  founders-os-tick detect [options]      Run data-condition detection, write the inbox
  founders-os-tick run --hold-only [opts] Drain the inbox: stage every fire for human review, perform nothing
  founders-os-tick --version
  founders-os-tick --help

detect options:
  --conditions=a,b   Restrict to these condition_types (default: all enabled)
  --dry              Evaluate without claiming or writing anything
  --json             Emit one machine-readable summary line
  --quiet            Suppress the human summary line

run options:
  --hold-only        REQUIRED today. Stage every inbox fire into the approval
                     queue for a human to approve/edit/reject; never sends or
                     performs anything. Full run mode (executing allowlisted
                     actions) is not available yet.
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

async function runHold(args: Args): Promise<number> {
  // Full run mode (executing allowlisted actions) is not built yet. Today the
  // only supported posture is --hold-only: stage everything, perform nothing.
  // This is enforced here AND by the server (an autonomous principal can never
  // clear a hold), so it is not a flag an operator can flip to "send".
  if (!args.holdOnly) {
    process.stderr.write(
      "[tick] run requires --hold-only. Full run mode (performing allowlisted actions unattended) is not available yet.\n"
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
  if (args.command === "detect") {
    return runDetect(args);
  }
  if (args.command === "run") {
    return runHold(args);
  }

  process.stderr.write(`[tick] unknown command "${args.command}".\n\n${USAGE}\n`);
  return EXIT_USAGE;
}

main().then((code) => process.exit(code));
