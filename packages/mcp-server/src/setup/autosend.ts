// ============================================================
// Founders OS — `founders-os-tick autosend <connector> --on|--off`
// ============================================================
// Turning on unattended sending is a deliberate, reversible act, never a
// side effect of connecting. It flips the company external_write tier between
// hold_for_approval (stage everything) and allow_with_log (low-risk sends go,
// recorded). The two red tiers (destructive, exfiltration) cannot be lowered
// — enforced server-side in validateTierOutcomes — so a sensitive send always
// stages regardless. This is why allow_with_log is defensible.
//
// The policy flip alone does not make the SCHEDULED job send: init wires a
// hold-only wrapper, which stages regardless of the tier. So when auto-send is
// turned on, this offers to upgrade an existing hold-only schedule to full-run
// (run --execute) — preflighting the Agent SDK + API key — so the tier change
// actually takes effect overnight. Reversible; hold-only stays the default.
// ============================================================

import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { buildContext, governanceTools } from "@ourthinktank/founders-os-core";
import { makePrompter, type Prompter } from "./prompt.js";
import { detectOs, defaultScheduler, managedPaths, type OsKind } from "./paths.js";
import { scheduleStatus } from "./registrar.js";
import { wrapperSh, wrapperCmd, buildEnvFile, parseEnvFile } from "./generators.js";
import { preflightExecute } from "./sdk.js";
import { RUNGS } from "./posture.js";

// Model defaults for an execute upgrade, matching plan.ts / S2.2 (an unset
// model falls back to the priciest SDK default, so never leave it blank).
const DEFAULT_AGENT_PROVIDER = "anthropic";
const DEFAULT_AGENT_MODEL = "claude-sonnet-5";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

export interface AutosendArgs {
  connector: string; // positional, e.g. "slack"
  on?: boolean; // --on => true, --off => false, undefined => usage error
  yes: boolean; // skip the confirm
}

/** Pure: the set_policy patch for a given on/off. */
export function buildAutosendPatch(on: boolean): { tier_outcomes: { external_write: "allow_with_log" | "hold_for_approval" } } {
  return { tier_outcomes: { external_write: on ? "allow_with_log" : "hold_for_approval" } };
}

type PolicyShape = { tier_outcomes: Record<string, string>; paused?: boolean };
const getPolicy = governanceTools.get_policy.handler as unknown as (ctx: unknown, args: unknown) => Promise<{ policy: PolicyShape }>;
const setPolicy = governanceTools.set_policy.handler as unknown as (ctx: unknown, args: unknown) => Promise<{ success: boolean; policy: PolicyShape }>;

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

/** Merge the model env an execute run needs into the wrapper's env file
 * (which the profile-less scheduled job sources), without clobbering the creds
 * init wrote. Fills provider/model defaults and carries the API key from the
 * environment if it's set here. */
function upgradeEnvFileForExecute(envFile: string, apiKeyVar: string): void {
  const env: Record<string, string> = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, "utf-8")) : {};
  if (!env.FOUNDERSOS_AGENT_PROVIDER) env.FOUNDERSOS_AGENT_PROVIDER = DEFAULT_AGENT_PROVIDER;
  if (!env.FOUNDERSOS_AGENT_MODEL) env.FOUNDERSOS_AGENT_MODEL = DEFAULT_AGENT_MODEL;
  const key = process.env[apiKeyVar];
  if (key && !env[apiKeyVar]) env[apiKeyVar] = key;
  writeFileSync(envFile, buildEnvFile(env), { mode: 0o600 });
  chmodSync(envFile, 0o600);
}

/** Is a tick schedule actually REGISTERED with the OS (not merely a wrapper
 * file on disk)? Mirrors doctor: check the OS default, then cron. A wrapper the
 * OS never calls is the exact false-success this guards against. */
function isScheduleRegistered(os: OsKind): boolean {
  if (scheduleStatus(os, defaultScheduler(os)).registered) return true;
  if (os !== "windows" && scheduleStatus(os, "cron").registered) return true;
  return false;
}

/** After turning auto-send ON, offer to upgrade a hold-only schedule to the
 * full-run wrapper so the tier change actually dispatches overnight. The
 * schedule points at the wrapper PATH, so rewriting the body is enough — no
 * re-registration. No-op when there's no schedule or it's already full-run. */
async function maybeUpgradeSchedule(prompter: Prompter): Promise<void> {
  const os = detectOs();
  const paths = managedPaths();
  const wrapperPath = os === "windows" ? paths.wrapperWin : paths.wrapperUnix;

  if (!existsSync(wrapperPath)) {
    out("\nNote: no scheduled job found yet. To run auto-send on a schedule, set one up with: founders-os-tick init --execute");
    return;
  }

  const body = readFileSync(wrapperPath, "utf-8");
  if (body.includes("run --execute")) {
    out("  Your scheduled job already runs full-run, so this takes effect on the next tick.");
    return;
  }

  out("\nYour scheduled job currently only stages (run --hold-only), so it won't send on its own yet.");
  const go = await prompter.confirm("Upgrade the scheduled job to full-run so auto-send takes effect overnight?", true);
  if (!go) {
    out("  Left as-is: the policy allows sending, but the schedule still only stages. Re-run this or `init --execute` when ready.");
    return;
  }

  const check = preflightExecute(out);

  const mode = "windows" === os ? wrapperCmd("execute") : wrapperSh("execute");
  const fileMode = os === "windows" ? 0o644 : 0o755;
  writeFileSync(wrapperPath, mode, { mode: fileMode });
  chmodSync(wrapperPath, fileMode);
  upgradeEnvFileForExecute(paths.envFile, check.apiKeyVar);

  // "Sending routine items" is rung 3. Use the shared wording so the story
  // matches doctor exactly.
  const sending = RUNGS[2];
  out(`✓ Scheduled job upgraded to full-run. You're now at "${sending.title}": ${sending.blurb}`);

  // Done-correctly, honestly: only claim it'll dispatch if a schedule really
  // calls this wrapper AND the runner can start.
  if (!isScheduleRegistered(os)) {
    out("  ⚠ But I don't see an active schedule calling it. Register one with `founders-os-tick init`, then check `founders-os-tick doctor`.");
  } else if (!check.ready) {
    out("  It won't dispatch until the model key is in place; run `founders-os-tick doctor` to confirm what's pending.");
  } else {
    out("  Run `founders-os-tick doctor` anytime to confirm it's working.");
  }
}

export async function runAutosend(a: AutosendArgs): Promise<number> {
  if (a.connector && a.connector !== "slack") {
    err(`[autosend] only "slack" is supported right now (got "${a.connector}"). Note: the tier is company-wide, so this governs every connector's external writes.`);
    return EXIT_FAIL;
  }
  if (a.on === undefined) {
    err("[autosend] specify --on (let low-risk messages send on their own) or --off (hold everything for approval).");
    return EXIT_USAGE;
  }

  let ctx;
  try {
    ctx = buildContext();
  } catch (e) {
    err(`[autosend] config error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAIL;
  }

  const prompter = makePrompter({ assumeYes: a.yes });
  try {
    const current = (await getPolicy(ctx, {})).policy.tier_outcomes.external_write;
    const target = a.on ? "allow_with_log" : "hold_for_approval";
    if (current === target) {
      out(`Auto-send is already ${a.on ? "on" : "off"} (external writes = ${current}). Nothing to change.`);
      return EXIT_OK;
    }

    if (a.on) {
      out("Turning auto-send ON means low-risk messages can post on their own, and are recorded.");
      out("Anything carrying a contact email, a secret, or a dollar figure is STILL held for you —");
      out("that floor cannot be turned off. You can reverse this anytime with --off.");
      const go = await prompter.confirm("Enable auto-send now?", false);
      if (!go) {
        out("Left unchanged. Still stage-first.");
        return EXIT_OK;
      }
    }

    const res = await setPolicy(ctx, buildAutosendPatch(a.on));
    const now = res.policy.tier_outcomes.external_write;
    out(`✓ Auto-send is now ${a.on ? "ON" : "OFF"} (external writes = ${now}).`);
    if (a.on) {
      out("  Reverse anytime: founders-os-tick autosend slack --off");
      await maybeUpgradeSchedule(prompter);
    }
    return EXIT_OK;
  } catch (e) {
    err(`[autosend] failed: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAIL;
  } finally {
    prompter.close();
  }
}
