// ============================================================
// Founders OS — Autonomous runner: hold-only mode
// ============================================================
// The deterministic, model-free core of `founders-os-tick run
// --hold-only`. It drains the trigger_fires inbox as the AUTONOMOUS
// principal and routes each fire's prepared action through the
// governance gate. In hold-only mode it performs NOTHING: hold-tier
// actions are staged for deferred approval (the autonomous gate's
// staged_for_deferred_approval outcome), and the runner never calls
// execute_action. A human later reviews each staged item (approve /
// edit / reject) via the H2 path.
//
// Layer 3 (single fail-closed chokepoint) for hold-only is structural:
// this module has no execute path at all, so a bug or a hijacked prompt
// cannot make it perform a side effect. The only writes are the staged
// approval rows the gate creates and the inbox bookkeeping below.
//
// What is intentionally deferred to the full (model-driven) run: fetching
// connector conditions, and drafting an abstract trigger action into a
// precise connector call. Here each fire is staged with the trigger's
// configured params and brief; a human refines it via the edit path at
// approval time. Connector-source fires never reach the inbox in Phase 1
// (detect skips them), so hold-only only ever sees data fires.
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import { loadPolicy } from "../governance/policy.js";
import { governanceTools } from "../governance/index.js";

interface TriggerFireRow {
  id: string;
  trigger_id: string;
  condition_type: string;
  brief: string;
  action: { action_type?: string; action_params?: Record<string, unknown> } | null;
  status: string;
}

export interface HoldOnlyResult {
  /** Pending inbox fires seen this run. */
  scanned: number;
  /** Fires staged into the approval queue for human review. */
  staged: number;
  /** Fires processed but not staged (blocked, or already cleared tier). */
  skipped: number;
  /** True when the company-wide kill switch is on; the run did nothing. */
  paused: boolean;
  /** Per-fire failures (isolated, not fatal). */
  errors: Array<{ fire_id: string; error: string }>;
}

/**
 * Represent an inbox fire as a proposed action for the gate. Conservative
 * by design: every fire is shaped as an EXTERNAL action so the autonomous
 * gate resolves it to a hold and stages it for review. The trigger's real
 * params and brief are carried through so the reviewer sees exactly what
 * the watch wanted and can edit it into the precise call at approval time.
 */
function fireToProposedAction(fire: TriggerFireRow) {
  const action = fire.action ?? {};
  const params = action.action_params ?? {};
  const verb = action.action_type ?? "notify";
  return {
    kind: "external" as const,
    connector: (typeof params.connector === "string" ? params.connector : undefined) ?? verb,
    action: verb,
    params,
    summary: fire.brief,
  };
}

/**
 * Drain the inbox in hold-only mode. Respects the pause kill switch,
 * stages each pending fire through preview_action as the autonomous
 * principal, marks it acted, and performs nothing. Per-fire failures are
 * collected, never thrown, so one bad fire does not starve the rest.
 */
export async function runHoldOnly(
  ctx: ToolContext,
  opts: { limit?: number } = {}
): Promise<HoldOnlyResult> {
  // Kill switch: if agents are paused company-wide, do nothing at all.
  const policy = await loadPolicy(ctx);
  if (policy.paused) {
    return { scanned: 0, staged: 0, skipped: 0, paused: true, errors: [] };
  }

  let q = ctx.db
    .from("trigger_fires")
    .select("id, trigger_id, condition_type, brief, action, status")
    .eq("company_id", ctx.companyId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (opts.limit && opts.limit > 0) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to load trigger_fires: ${error.message}`);
  const fires = (data ?? []) as TriggerFireRow[];

  const a = ctx.actor;
  const actedBy = a && a.kind === "autonomous" ? `autonomous-run:${a.runId}` : "autonomous-run";
  let staged = 0;
  let skipped = 0;
  const errors: Array<{ fire_id: string; error: string }> = [];

  const previewHandler = governanceTools.preview_action.handler as (
    c: ToolContext,
    p: unknown
  ) => Promise<{ outcome: string }>;

  for (const fire of fires) {
    try {
      const action = fireToProposedAction(fire);
      const res = await previewHandler(ctx, { action, source: `trigger:${fire.trigger_id}` });
      // Hold-only NEVER executes. A hold is staged by preview_action; any
      // other outcome (a blocked SSRF payload, etc.) is left for a human to
      // notice. Either way the fire has been processed once.
      if (res.outcome === "staged_for_deferred_approval") staged++;
      else skipped++;

      const { error: upErr } = await ctx.db
        .from("trigger_fires")
        .update({ status: "acted", acted_at: new Date().toISOString(), acted_by: actedBy })
        .eq("company_id", ctx.companyId)
        .eq("id", fire.id);
      if (upErr) throw new Error(upErr.message);
    } catch (e) {
      errors.push({ fire_id: fire.id, error: e instanceof Error ? e.message : "unknown error" });
    }
  }

  return { scanned: fires.length, staged, skipped, paused: false, errors };
}
