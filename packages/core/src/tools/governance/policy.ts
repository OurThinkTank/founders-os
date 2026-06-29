// ============================================================
// Founders OS — Governance Policy
// ============================================================
// One row per company in guardrail_policy maps each risk tier to an
// outcome, plus two global overrides: dry_run (hold + log everything)
// and paused (a kill switch that stops all agent action). This module
// holds the PURE resolution logic (tier -> outcome, with the
// non-negotiable floor on the red tiers) and the ctx-bound load/save.
//
// THE FLOOR: destructive and exfiltration are ALWAYS hold_for_approval.
// resolveOutcome enforces it at read time (so even a hand-edited row
// cannot lower them) and validateTierOutcomes enforces it at write time
// (so set_policy refuses the attempt with a clear error). Two layers on
// purpose: the gate's one real lever is that a human, not the agent,
// clears the worst actions.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import { RED_TIERS, type RiskTier } from "../playbooks/risk.js";

export type TierOutcome = "allow" | "allow_with_log" | "hold_for_approval";

/** What preview_action actually returns; adds the override-only value. */
export type ResolvedOutcome = TierOutcome | "paused";

export type TierOutcomes = Record<RiskTier, TierOutcome>;

export interface GuardrailPolicy {
  company_id: string;
  tier_outcomes: TierOutcomes;
  dry_run: boolean;
  paused: boolean;
}

/** Mirrors the column default in the migration. */
export const DEFAULT_TIER_OUTCOMES: TierOutcomes = {
  read: "allow",
  native_create: "allow_with_log",
  external_write: "hold_for_approval",
  destructive: "hold_for_approval",
  exfiltration: "hold_for_approval",
};

export const VALID_OUTCOMES: ReadonlySet<string> = new Set<TierOutcome>([
  "allow",
  "allow_with_log",
  "hold_for_approval",
]);

/**
 * Resolve the outcome for a tier under a policy. Precedence:
 *   paused      -> "paused" for every tier (kill switch wins)
 *   dry_run     -> "hold_for_approval" for every tier (hold + log all)
 *   red floor   -> destructive / exfiltration always hold
 *   otherwise   -> the stored tier outcome
 */
export function resolveOutcome(
  policy: GuardrailPolicy,
  tier: RiskTier
): ResolvedOutcome {
  if (policy.paused) return "paused";
  if (policy.dry_run) return "hold_for_approval";
  if (RED_TIERS.has(tier)) return "hold_for_approval";
  return policy.tier_outcomes[tier] ?? DEFAULT_TIER_OUTCOMES[tier];
}

/**
 * Validate a proposed tier_outcomes map. Throws on an unknown outcome
 * value and on any attempt to set destructive or exfiltration below
 * hold_for_approval. Returns a complete, normalized map (missing tiers
 * fall back to the defaults).
 */
export function validateTierOutcomes(
  proposed: Partial<Record<string, string>>
): TierOutcomes {
  const result: TierOutcomes = { ...DEFAULT_TIER_OUTCOMES };
  for (const [tier, outcome] of Object.entries(proposed)) {
    if (!(tier in DEFAULT_TIER_OUTCOMES)) {
      throw new Error(`Unknown risk tier "${tier}".`);
    }
    if (outcome === undefined) continue;
    if (!VALID_OUTCOMES.has(outcome)) {
      throw new Error(
        `Invalid outcome "${outcome}" for tier "${tier}". Use allow, allow_with_log, or hold_for_approval.`
      );
    }
    if (RED_TIERS.has(tier as RiskTier) && outcome !== "hold_for_approval") {
      throw new Error(
        `Tier "${tier}" must stay at hold_for_approval; it cannot be lowered to "${outcome}".`
      );
    }
    result[tier as RiskTier] = outcome as TierOutcome;
  }
  return result;
}

/**
 * Load the company's policy, falling back to defaults when no row
 * exists yet (a fresh install has not called set_policy). Read-only;
 * does not create a row.
 */
export async function loadPolicy(ctx: ToolContext): Promise<GuardrailPolicy> {
  const { data, error } = await ctx.db
    .from("guardrail_policy")
    .select("company_id, tier_outcomes, dry_run, paused")
    .eq("company_id", ctx.companyId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load guardrail policy: ${error.message}`);

  if (!data) {
    return {
      company_id: ctx.companyId,
      tier_outcomes: { ...DEFAULT_TIER_OUTCOMES },
      dry_run: false,
      paused: false,
    };
  }

  // Merge stored outcomes over defaults so a partial row is still complete.
  const stored = (data.tier_outcomes ?? {}) as Partial<TierOutcomes>;
  return {
    company_id: data.company_id,
    tier_outcomes: { ...DEFAULT_TIER_OUTCOMES, ...stored },
    dry_run: Boolean(data.dry_run),
    paused: Boolean(data.paused),
  };
}

/**
 * Upsert the company's policy row. Pass only the fields being changed;
 * the others are preserved from the current row (or defaults).
 */
export async function savePolicy(
  ctx: ToolContext,
  patch: Partial<Pick<GuardrailPolicy, "tier_outcomes" | "dry_run" | "paused">>
): Promise<GuardrailPolicy> {
  const current = await loadPolicy(ctx);
  const next: GuardrailPolicy = {
    company_id: ctx.companyId,
    tier_outcomes: patch.tier_outcomes ?? current.tier_outcomes,
    dry_run: patch.dry_run ?? current.dry_run,
    paused: patch.paused ?? current.paused,
  };

  const { error } = await ctx.db.from("guardrail_policy").upsert(
    {
      company_id: ctx.companyId,
      tier_outcomes: next.tier_outcomes,
      dry_run: next.dry_run,
      paused: next.paused,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "company_id" }
  );

  if (error) throw new Error(`Failed to save guardrail policy: ${error.message}`);
  return next;
}
