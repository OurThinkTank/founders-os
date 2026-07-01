// ============================================================
// Founders OS — `founders-os-tick autosend <connector> --on|--off`
// ============================================================
// Turning on unattended sending is a deliberate, reversible act, never a
// side effect of connecting. It flips the company external_write tier between
// hold_for_approval (stage everything) and allow_with_log (low-risk sends go,
// recorded). The two red tiers (destructive, exfiltration) cannot be lowered
// — enforced server-side in validateTierOutcomes — so a sensitive send always
// stages regardless. This is why allow_with_log is defensible.
// ============================================================

import { buildContext, governanceTools } from "@ourthinktank/founders-os-core";
import { makePrompter } from "./prompt.js";

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
    if (a.on) out("  Reverse anytime: founders-os-tick autosend slack --off");
    return EXIT_OK;
  } catch (e) {
    err(`[autosend] failed: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_FAIL;
  } finally {
    prompter.close();
  }
}
