// ============================================================
// Founders OS - Render Type
// ============================================================
// Shared type for the `render` field attached to render-bearing
// tool responses. Replaces the legacy `display_hint` shape.
//
// The shape encodes the four-tier capability ladder defined in
// contract.ts (RENDERING_CONTRACT):
//
//   tier_1 (required): Visual primitive tool. The agent calls
//     an artifact/widget/canvas tool and uses
//     `tier_1.format_hint` + `tier_1.instructions` for guidance.
//   tier_2 (optional): Inline HTML/SVG/JSX. Falls back to
//     tier_1.instructions if omitted.
//   tier_3 (optional): Pre-rendered markdown fallback. Always
//     present on data tools. Omitted on conflict (interactive)
//     responses where falling through to prose would be wrong.
//   tier_4 (no block): Prose summary. Agent composes from
//     tier_3.markdown or raw response data.
//
// `do_not` carries cross-tier guardrails the agent should
// respect at every tier (e.g., "do not invent new color
// meanings; use the standard conventions").
//
// `instructions` is always Scope / Format / Forbidden - written
// as directives a literal-following model can act on without
// inferring. The plan calls this out specifically for Opus 4.7.
// ============================================================

/**
 * Recipe pointer for the agent's renderer. Each value implies
 * a default rendering pattern the agent can use when it does
 * not parse the directive in `instructions`.
 *
 * Authoritative override: `instructions.format` wins over the
 * default recipe implied by `format_hint`. See TOOL_PATTERNS.md
 * for the precedence rule.
 *
 * Unknown values: if an agent sees a `format_hint` it does not
 * recognize, it must fall through to `render.tier_3.markdown`
 * (RENDERING_CONTRACT states this explicitly).
 *
 * Open union, no formal versioning. New values land in normal
 * releases alongside the tool that needs them. Drift between
 * server and plugin is surfaced by the contract_version sentinel
 * on get_version + get_session_start.expected_contract_version.
 */
export type FormatHint =
  // Data-shape recipes
  | "metric_cards"      // headline numbers + breakdowns (get_dashboard, get_financial_summary)
  | "status_groups"     // grouped items with header chips (get_task_summary, get_stuck_list, get_weekly_retro default)
  | "kanban"            // columns by status (list_tasks)
  | "timeline"          // chronological entries newest-first (get_project_history)
  | "table"             // tabular data (list_transactions, list_customers, get_pl_report)
  | "headline_list"     // ranked headlines (get_feed_briefing)
  | "narrative"         // prose draft (get_weekly_retro with format: "linkedin")
  // Orchestration recipes
  | "parallel_briefing" // briefing assembly orchestrator (get_session_start)
  // Non-normal response recipes
  | "decision"          // interactive option chooser (conflict responses)
  | "incident";         // partial-success / failure detail with manual action

/**
 * Scope / Format / Forbidden directive block. Written so a
 * literal-following model can act on it without inferring.
 *
 * - scope: which data fields to render and how to group them
 * - format: which visual primitive to use, referencing the
 *           standard color conventions by name where relevant
 * - forbidden: what not to do (omissions, summarization, tier
 *              fall-through when a higher tier is available)
 */
export interface RenderInstructions {
  scope: string;
  format: string;
  forbidden: string;
}

/**
 * Tier 1 - visual primitive tool. Required on every render
 * block. The agent calls an artifact/widget/canvas tool when
 * one is available and uses these instructions for guidance.
 */
export interface RenderTier1 {
  format_hint: FormatHint;
  instructions: RenderInstructions;
}

/**
 * Tier 2 - inline rich output (HTML/SVG/JSX emitted in the
 * agent's message). Optional. When omitted, the agent falls
 * back to tier_1.instructions for guidance at this tier.
 */
export interface RenderTier2 {
  instructions: RenderInstructions;
}

/**
 * Tier 3 - pre-rendered markdown fallback. Present on every
 * data-tool response. Omitted on:
 *   - conflict responses (format_hint: "decision") because
 *     conflicts are interactive; falling through to prose
 *     would be the wrong UX
 *   - orchestrator responses (format_hint: "parallel_briefing")
 *     because the orchestrator has no data of its own
 */
export interface RenderTier3 {
  markdown: string;
}

/**
 * The full render block attached to a tool response under
 * the `render` key.
 */
export interface Render {
  tier_1: RenderTier1;
  tier_2?: RenderTier2;
  tier_3?: RenderTier3;
  /**
   * Cross-tier guardrails (e.g., "for fewer than 3 rows,
   * do not build an artifact"; "do not invent new color
   * meanings; use the standard conventions").
   */
  do_not?: string[];
}
