// ============================================================
// Founders OS — `founders-os-tick init`
// ============================================================
// One guided command that turns on the overnight clock with nothing edited
// by hand. It gathers config (prefilling from the environment), writes the
// env file + wrapper + scheduler unit into ONE config dir, registers the
// schedule with the OS, and runs a first detect so the user sees it work.
//
// First run wires the SAFE posture by default: the scheduled wrapper runs
// `detect` then `run --hold-only`, so it prepares and stages, never sends.
// Turning on unattended sending is a separate, later step (autosend).
//
// `init --execute` is the explicit opt-in to full-run auto-dispatch: it
// preflights the Agent SDK + API key, writes the model env, and wires the
// wrapper to `run --execute`. Hold-only stays the default so nothing sends
// unless a founder deliberately asks for it.
// ============================================================

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { buildContext, evaluateDataTriggers } from "@ourthinktank/founders-os-core";
import { detectOs, defaultScheduler, managedPaths, unitPaths } from "./paths.js";
import { buildInitPlan, type InitConfig } from "./plan.js";
import { runCommands } from "./registrar.js";
import { makePrompter } from "./prompt.js";
import { checkTickBinResolves, localSelfInvocation } from "./resolve.js";
import { preflightExecute } from "./sdk.js";
import { RUNGS } from "./posture.js";
import type { Cadence } from "./generators.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;

const CRED_KEYS = ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "FOUNDERS_OS_COMPANY_ID", "FOUNDERS_OS_USER_ID", "FOUNDERS_OS_TIMEZONE"] as const;
// Model env carried into the wrapper's env file when --execute is on, so the
// scheduled (profile-less) job can reach the provider. The provider's API key
// is added dynamically from the resolved apiKeyVar.
const EXECUTE_ENV_KEYS = ["FOUNDERSOS_AGENT_PROVIDER", "FOUNDERSOS_AGENT_MODEL"] as const;
const DEFAULT_TICK_BIN = "npx -y -p @ourthinktank/founders-os@latest founders-os-tick";

export interface InitArgs {
  yes: boolean; // non-interactive: take defaults
  cadence?: Cadence; // --cadence=hourly|daily
  hour?: number; // --hour=N for daily
  cron?: boolean; // force cron instead of the OS default
  tickBin?: string; // --tick-bin override
  execute?: boolean; // --execute: opt into full-run auto-dispatch
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

    // Resolve how the scheduled wrapper invokes the tick CLI. The published
    // npx form is the default (the expected case). Preflight it so a founder
    // does not discover a "command not found" at 3am; self-heal to the current
    // local build when the published command is not reachable (dev / global).
    let tickBin = a.tickBin ?? DEFAULT_TICK_BIN;
    out("Checking the scheduled command resolves (this can take a moment)...");
    let check = checkTickBinResolves(tickBin);
    if (!check.ok && !a.tickBin) {
      const local = localSelfInvocation();
      if (local) {
        const localCheck = checkTickBinResolves(local);
        if (localCheck.ok) {
          tickBin = local;
          check = localCheck;
          out(`  The published command wasn't reachable, so I pointed the schedule at this build: ${local}`);
        }
      }
    }
    if (check.ok) {
      out(`✓ Command resolves: ${check.detail}`);
    } else {
      err(`  ⚠ The scheduled command "${tickBin}" didn't resolve here (${check.detail}).`);
      err("    The hourly job may fail. Fix: install globally (npm i -g @ourthinktank/founders-os),");
      err("    or re-run with --tick-bin=\"node /abs/path/to/dist/tick.js\". Then check `founders-os-tick doctor`.");
    }

    // ── Full-run opt-in (--execute): preflight the Agent SDK + API key and
    // carry the model config into the wrapper's env file. Hold-only otherwise. ──
    const execute = a.execute === true;
    if (execute) {
      out("\nSetting up full-run auto-dispatch (run --execute).");
      const check = preflightExecute(out);
      // The scheduled job doesn't inherit your shell, so any model config it
      // needs must live in the env file. Carry over what's set; plan.ts fills
      // provider/model defaults when they're absent.
      for (const k of EXECUTE_ENV_KEYS) {
        const v = process.env[k];
        if (v) creds[k] = v;
      }
      const apiKey = process.env[check.apiKeyVar];
      if (apiKey) creds[check.apiKeyVar] = apiKey;
      if (!check.ready) {
        out("  Full-run scheduled anyway; it won't dispatch until the above is resolved. Check `founders-os-tick doctor`.");
      }
    }

    const cfg: InitConfig = { os, scheduler, cadence, dailyHour, execute, tickBin, creds, paths, units };
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

    // Close by naming the rung just provisioned, in the same words `doctor`
    // uses, plus the next step. Execute schedule = "Triaging"; else "Preparing".
    const rung = execute ? RUNGS[1] : RUNGS[0];
    out(`\nYou're set. You're now at "${rung.title}": ${rung.blurb}`);
    if (execute) {
      out("To let routine messages send on their own, next connect a channel and turn on auto-send:");
      out("  founders-os-tick connect slack   then   founders-os-tick autosend slack --on");
    }
    out('Run "founders-os-tick doctor" anytime to see where you are and what is next.');
    return EXIT_OK;
  } finally {
    prompter.close();
  }
}
