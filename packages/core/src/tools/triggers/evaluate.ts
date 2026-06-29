// ============================================================
// Founders OS — Trigger Evaluation (shared detection core)
// ============================================================
// The data-condition detection loop, lifted out of the
// evaluate_triggers tool handler so the SAME implementation runs in
// two places:
//
//   * the evaluate_triggers MCP tool (interactive / in-session), and
//   * the headless `founders-os-tick detect` CLI (no model), which
//     additionally writes fires to the trigger_fires inbox so a later
//     session can drain them.
//
// Keeping one implementation is the whole point: the fingerprint /
// dedup / fire-claim contract must behave identically whether a human
// asked or the clock did. Connector conditions are NOT fired here (the
// server cannot query them); they are returned raw so the caller can
// build connector checks. Detection is deterministic and server-owned.
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import { writeAuditLog } from "../audit.js";
import { fingerprint, changed } from "./dedup.js";
import { dataEvaluators } from "./conditions.js";

export const TRIGGER_SELECT =
  "id, name, scope, owner_id, condition_source, condition_type, connector, params, action_type, playbook_id, action_params, last_state, created_by, enabled";

export interface TriggerRow {
  id: string;
  name: string;
  scope?: "org" | "personal";
  owner_id?: string | null;
  condition_source: "data" | "connector";
  condition_type: string;
  connector: string | null;
  params: Record<string, unknown> | null;
  action_type: string;
  playbook_id: string | null;
  action_params: Record<string, unknown> | null;
  last_state: string | null;
  created_by: string;
  enabled: boolean;
}

// ── Fire-claim (atomic conditional UPDATE) ─────────────────
// Claims the fire for one trigger by moving last_state to the new
// fingerprint ONLY when it differs (IS DISTINCT FROM, including the
// first-ever evaluation where last_state is null). Two overlapping
// ticks therefore serialize: the first claims and the second sees the
// fingerprint already stored and does nothing. last_fired_at is bumped
// only when the condition actually matched, so a transition to
// "no longer matching" updates state (so re-matching re-fires) without
// recording a fire.
export async function claimFire(
  ctx: ToolContext,
  triggerId: string,
  fp: string,
  matched: boolean
): Promise<boolean> {
  const patch: Record<string, unknown> = { last_state: fp };
  if (matched) patch.last_fired_at = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("triggers")
    .update(patch)
    .eq("company_id", ctx.companyId)
    .eq("id", triggerId)
    // IS DISTINCT FROM: matches when last_state is null OR differs.
    .or(`last_state.is.null,last_state.neq.${fp}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Fire-claim failed for trigger ${triggerId}: ${error.message}`);
  return Boolean(data);
}

// ── Resolved-action reference for a fired trigger ──────────
export function resolvedActionRef(t: TriggerRow, brief: string) {
  return {
    trigger_id: t.id,
    name: t.name,
    condition_type: t.condition_type,
    brief,
    action: {
      action_type: t.action_type,
      playbook_id: t.playbook_id,
      // Templated params; resolved + classified inside preview_action.
      action_params: t.action_params ?? {},
    },
    next_step:
      "Route this action through preview_action before performing it; if held, wait for a human approval.",
  };
}

export type DataFire = ReturnType<typeof resolvedActionRef>;

export interface TriggerError {
  trigger_id: string;
  name: string;
  error: string;
}

export interface EvaluateDataResult {
  /** Count of data conditions actually evaluated (excludes connector + misconfigured). */
  evaluated: number;
  /** Data triggers that newly fired this run, each a resolved-action reference. */
  fired: DataFire[];
  /** Enabled connector-source triggers, returned raw for the caller to build checks. */
  connectorTriggers: TriggerRow[];
  /** Per-trigger failures (isolated, not fatal). */
  errors: TriggerError[];
}

export interface EvaluateDataOptions {
  /** Restrict to these condition_types. Omit for all enabled triggers. */
  conditionTypes?: string[];
  /** Evaluate without fire-claiming or any state write. Default false. */
  dryEvaluate?: boolean;
  /**
   * When true, every newly fired data trigger is upserted into the
   * trigger_fires inbox (one live row per trigger). The headless detect
   * tick sets this so fires are waiting for the next session; the MCP
   * tool leaves it false because it returns fires in its response.
   */
  writeInbox?: boolean;
}

/**
 * Upsert one fire into the trigger_fires inbox. One live row per trigger
 * (unique on company_id + trigger_id): a worsening re-fire refreshes the
 * existing row back to 'pending' rather than stacking duplicates. Because
 * this only runs when claimFire returned true (a new or worsened state),
 * the inbox inherits the same signal-not-noise property as dedup.
 */
async function upsertTriggerFire(
  ctx: ToolContext,
  t: TriggerRow,
  fire: DataFire,
  fp: string
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await ctx.db.from("trigger_fires").upsert(
    {
      company_id: ctx.companyId,
      trigger_id: t.id,
      condition_type: t.condition_type,
      brief: fire.brief,
      fingerprint: fp,
      action: fire.action,
      status: "pending",
      acted_at: null,
      acted_by: null,
      created_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "company_id,trigger_id" }
  );
  if (error) throw new Error(`Failed to write trigger_fire for ${t.id}: ${error.message}`);
}

/**
 * Evaluate enabled data-condition triggers for the company: deterministic
 * SQL evaluation, dedup fingerprint, atomic fire-claim, and (optionally)
 * an inbox upsert per fire. Connector-source triggers are collected and
 * returned raw, not fired. Per-trigger failures are isolated and returned
 * in `errors`, never thrown, so one bad watch does not starve the rest.
 */
export async function evaluateDataTriggers(
  ctx: ToolContext,
  opts: EvaluateDataOptions = {}
): Promise<EvaluateDataResult> {
  const { conditionTypes, dryEvaluate = false, writeInbox = false } = opts;

  let q = ctx.db
    .from("triggers")
    .select(TRIGGER_SELECT)
    .eq("company_id", ctx.companyId)
    .eq("enabled", true)
    .is("deleted_at", null);
  if (conditionTypes && conditionTypes.length > 0) q = q.in("condition_type", conditionTypes);
  const { data, error } = await q;
  if (error) throw new Error(`Failed to load triggers: ${error.message}`);
  const triggers = (data ?? []) as TriggerRow[];

  const fired: DataFire[] = [];
  const connectorTriggers: TriggerRow[] = [];
  const errors: TriggerError[] = [];
  let evaluated = 0;

  for (const t of triggers) {
    try {
      if (t.condition_source === "connector") {
        connectorTriggers.push(t);
        continue;
      }
      const evaluator = dataEvaluators[t.condition_type];
      if (!evaluator) {
        errors.push({
          trigger_id: t.id,
          name: t.name,
          error: `No data evaluator for condition_type "${t.condition_type}"; the trigger is misconfigured and never fires.`,
        });
        continue;
      }
      evaluated++;
      // A personal watch restricts evaluation to its owner's records for
      // conditions that have a per-user owner (the task conditions); other
      // conditions ignore scope and evaluate company-wide (M3).
      const result = await evaluator(ctx, t.params ?? {}, {
        scope: t.scope ?? "org",
        ownerId: t.owner_id ?? null,
      });
      const fp = fingerprint(result.rows.map((r) => r.id), result.state_field);

      if (dryEvaluate) {
        if (result.matched && changed(t.last_state, fp)) fired.push(resolvedActionRef(t, result.brief));
        continue;
      }

      const claimed = await claimFire(ctx, t.id, fp, result.matched);
      if (result.matched && claimed) {
        await writeAuditLog(ctx, {
          action: "trigger_fired",
          entity_type: "trigger",
          entity_id: t.id,
          metadata: { condition_type: t.condition_type, brief: result.brief, source: "data" },
        });
        const fire = resolvedActionRef(t, result.brief);
        if (writeInbox) await upsertTriggerFire(ctx, t, fire, fp);
        fired.push(fire);
      }
    } catch (e) {
      errors.push({ trigger_id: t.id, name: t.name, error: e instanceof Error ? e.message : "unknown error" });
    }
  }

  return { evaluated, fired, connectorTriggers, errors };
}
