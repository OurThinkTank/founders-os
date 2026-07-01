// ============================================================
// Founders OS — `founders-os-tick init`
// ============================================================
// One guided command that turns on the overnight clock with nothing edited
// by hand. It gathers config (prefilling from the environment), writes the
// env file + wrapper + scheduler unit into ONE config dir, registers the
// schedule with the OS, and runs a first detect so the user sees it work.
//
// First run wires the SAFE posture only: the scheduled wrapper runs
// `detect` then `run --hold-only`, so it prepares and stages, never sends.
// Turning on unattended sending is a separate, later step (S3.6 autosend).
// ============================================================

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { buildContext, evaluateDataTriggers } from "@ourthinktank/founders-os-core";
import { detectOs, defaultScheduler, managedPaths, unitPaths } from "./paths.js";
import { buildInitPlan, type InitConfig } from "./plan.js";
import { runCommands } from "./registrar.js";
import { makePrompter } from "./prompt.js";
import type { Cadence } from "./generators.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;

const CRED_KEYS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "FOUNDERS_OS_COMPANY_ID", "FOUNDERS_OS_USER_ID", "FOUNDERS_OS_TIMEZONE"] as const;
const DEFAULT_TICK_BIN = "npx -y -p @ourthinktank/founders-os@latest founders-os-tick";

export interface InitArgs {
  yes: boolean; // non-interactive: take defaults
  cadence?: Cadence; // --cadence=hourly|daily
  hour?: number; // --hour=N for daily
  cron?: boolean; // force cron instead of the OS default
  tickBin?: string; // --tick-bin override
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

export async function runInit(a: InitArgs): Promise<number> {
  const os = detectOs();
  const paths = managedPaths();
  const units = unitPaths();
  const prompter = makePrompter({ assumeYes: a.yes });

  try {
    out("Founders OS setup — let's get your watches running automatically.\n");

    // ── Credentials: prefill from the environment, prompt for what's missing ──
    const creds: Record<string, string> = {};
    for (const k of CRED_KEYS) {
      const v = process.env[k];
      if (v) creds[k] = v;
    }
    if (creds.SUPABASE_URL) {
      out("✓ Found your Founders OS credentials in the environment.");
    } else {
      creds.SUPABASE_URL = (await prompter.ask("Supabase URL")).trim();
      creds.SUPABASE_SECRET_KEY = (await prompter.ask("Supabase secret key")).trim();
    }
    if (!creds.SUPABASE_URL || !creds.SUPABASE_SECRET_KEY) {
      err("[init] SUPABASE_URL and SUPABASE_SECRET_KEY are required (set them in the environment or answer the prompts).");
      return EXIT_FAIL;
    }

    // ── Cadence ──
    let cadence: Cadence = a.cadence ?? "hourly";
    if (!a.cadence) {
      cadence = await prompter.choice(
        "How often should I check your watches?",
        [
          { label: "Every hour (recommended)", value: "hourly" as Cadence },
          { label: "Once a day", value: "daily" as Cadence },
        ],
        0
      );
    }
    const dailyHour = a.hour ?? 6;

    // ── Scheduler + how the wrapper invokes the CLI ──
    // --cron only applies to unix; Windows always uses Task Scheduler.
    const scheduler = a.cron && os !== "windows" ? "cron" : defaultScheduler(os);
    const tickBin = a.tickBin ?? DEFAULT_TICK_BIN;

    const cfg: InitConfig = { os, scheduler, cadence, dailyHour, execute: false, tickBin, creds, paths, units };
    const plan = buildInitPlan(cfg);

    // ── Write everything into one config dir ──
    for (const f of plan.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content, { mode: f.mode });
      chmodSync(f.path, f.mode); // ensure mode even if the file pre-existed
    }
    out(`✓ Wrote your settings to ${paths.configDir} (locked to you).`);

    // ── Register the schedule with the OS ──
    const results = runCommands(plan.register);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      err(`[init] the schedule was written but registration hit a snag:`);
      for (const r of failed) err(`  - ${r.desc}: ${r.detail ?? "failed"}`);
      if (scheduler === "systemd") err("  Tip: if you have no systemd user session, re-run with --cron.");
      return EXIT_FAIL;
    }
    out(`✓ Registered an ${cadence} check with ${scheduler}.`);
    if (os === "windows") {
      out('  (Runs while you\'re logged on. To run while logged off, open Task Scheduler → "FoundersOS Tick" → tick "Run whether user is logged on or not".)');
    }

    // ── First check now, so the user sees it work ──
    for (const [k, v] of Object.entries(creds)) if (!process.env[k]) process.env[k] = v;
    try {
      const ctx = buildContext();
      const res = await evaluateDataTriggers(ctx, { writeInbox: true });
      out(`✓ Ran a first check just now: ${res.fired.length} watch(es) fired, all prepared for you.`);
      for (const f of res.fired) out(`    • ${f.name}: ${f.brief}`);
    } catch (e) {
      err(`[init] setup is done, but the first check could not run: ${e instanceof Error ? e.message : String(e)}`);
      // Non-fatal: the schedule is registered; the next tick will try again.
    }

    out("\nYou're set. I'll check on your cadence and prepare anything that needs you.");
    out('Nothing gets sent on its own. Run "founders-os-tick doctor" anytime to see status.');
    return EXIT_OK;
  } finally {
    prompter.close();
  }
}
