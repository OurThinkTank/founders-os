// ============================================================
// Founders OS — Trigger Condition Evaluators (data source)
// ============================================================
// One evaluator per `data` condition_type. Each runs deterministic
// SQL against existing CRM / financial / task data using ctx.db scoped
// to ctx.companyId, and returns { matched, rows, state_field, brief }:
//
//   matched     - is the condition currently true? (only a matched +
//                 changed condition fires)
//   rows        - the ids of the matching entities; folded into the
//                 dedup fingerprint so a changed match set re-fires
//   state_field - the per-condition MATERIAL STATE used by dedup so a
//                 WORSENING situation re-fires even when the rows are the
//                 same (a deal slipping from the 14-day to the 30-day
//                 bucket; spend crossing the next multiple of a threshold)
//   brief       - a short human description for the fired set
//
// Connector conditions (overdue_invoice, feed_keyword_match) are NOT
// here: the server cannot query them, so they go through connector.ts +
// report_trigger_observation. See that file.
// ============================================================

import type { ToolContext } from "../../types/context.js";

export interface EvalResult {
  matched: boolean;
  rows: { id: string }[];
  state_field: string;
  brief: string;
}

/**
 * The owning scope of the trigger being evaluated. A 'personal' watch with
 * an ownerId restricts evaluation to that owner's records FOR CONDITIONS
 * THAT HAVE A PER-USER OWNER (today: the task conditions, filtered by
 * assigned_to OR created_by). Conditions whose underlying data has no
 * per-user owner (stalled_deal on customers, overspend / budget_threshold
 * on the company books) ignore this and evaluate company-wide; for those,
 * scope is a presentation label, not an isolation boundary (see M3 in the
 * 2026-06-29 proactive-agents review). 'org' scope always evaluates
 * company-wide.
 */
export interface EvalScope {
  scope: "org" | "personal";
  ownerId: string | null;
}

export type DataEvaluator = (
  ctx: ToolContext,
  params: Record<string, unknown>,
  scope?: EvalScope
) => Promise<EvalResult>;

/** True when a personal watch should restrict to a specific owner's rows. */
function isOwnerScoped(scope?: EvalScope): scope is EvalScope & { ownerId: string } {
  return scope?.scope === "personal" && typeof scope.ownerId === "string" && scope.ownerId.length > 0;
}

// ── Shared helpers ─────────────────────────────────────────

/** Days-bucket label so a worsening age crosses a boundary and re-fires. */
export function daysBucket(days: number): string {
  if (days < 3) return "b0";
  if (days < 7) return "b1";
  if (days < 14) return "b2";
  if (days < 30) return "b3";
  if (days < 60) return "b4";
  return "b5";
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function daysBetweenDates(pastDateStr: string): number {
  const then = new Date(pastDateStr + "T00:00:00Z").getTime();
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

/**
 * Build the per-row state field: a sorted list of "id:bucket" pairs.
 * Any row whose bucket changes (worsens) changes this string, so the
 * dedup fingerprint changes and the trigger re-fires. Stable ordering
 * makes it deterministic regardless of query row order.
 */
function perRowState(pairs: Array<{ id: string; bucket: string }>): string {
  return pairs
    .map((p) => `${p.id}:${p.bucket}`)
    .sort()
    .join(",");
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ── stalled_deal: CRM customer stuck in a pipeline phase ───
// "Deal" = a customer in a non-terminal pipeline phase that has not
// moved (been edited) in N days. updated_at is the best available
// movement signal; there is no phase_changed_at column (documented
// approximation, refine later).

const DEFAULT_PIPELINE_PHASES = ["prospect", "lead", "opportunity"];

const stalled_deal: DataEvaluator = async (ctx, params) => {
  const days = asInt(params.days, 14);
  const phases =
    Array.isArray(params.phases) && params.phases.length > 0
      ? (params.phases as string[])
      : DEFAULT_PIPELINE_PHASES;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await ctx.db
    .from("customers")
    .select("id, organization_name, customer_phase, updated_at")
    .eq("company_id", ctx.companyId)
    .in("customer_phase", phases)
    .lt("updated_at", cutoff)
    .is("deleted_at", null);
  if (error) throw new Error(`stalled_deal evaluation failed: ${error.message}`);

  const matchedRows = (data ?? []) as Array<{ id: string; organization_name: string; updated_at: string }>;
  const pairs = matchedRows.map((r) => ({ id: r.id, bucket: daysBucket(daysSince(r.updated_at)) }));
  return {
    matched: matchedRows.length > 0,
    rows: matchedRows.map((r) => ({ id: r.id })),
    state_field: perRowState(pairs),
    brief: `${matchedRows.length} deal${matchedRows.length === 1 ? "" : "s"} with no movement in ${days}+ days`,
  };
};

// ── stuck_task: in_progress task with no movement ──────────

const stuck_task: DataEvaluator = async (ctx, params, scope) => {
  const days = asInt(params.days, 7);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  let q = ctx.db
    .from("tasks")
    .select("id, title, updated_at")
    .eq("company_id", ctx.companyId)
    .eq("status", "in_progress")
    .lt("updated_at", cutoff)
    .is("deleted_at", null);
  // A personal watch sees only the owner's tasks (assigned to OR created by).
  if (isOwnerScoped(scope)) q = q.or(`assigned_to.eq.${scope.ownerId},created_by.eq.${scope.ownerId}`);
  const { data, error } = await q;
  if (error) throw new Error(`stuck_task evaluation failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; updated_at: string }>;
  const pairs = rows.map((r) => ({ id: r.id, bucket: daysBucket(daysSince(r.updated_at)) }));
  return {
    matched: rows.length > 0,
    rows: rows.map((r) => ({ id: r.id })),
    state_field: perRowState(pairs),
    brief: `${rows.length} in-progress task${rows.length === 1 ? "" : "s"} untouched for ${days}+ days`,
  };
};

// ── overdue_task: todo/in_progress past its due date ───────

const overdue_task: DataEvaluator = async (ctx, params, scope) => {
  const graceDays = asInt(params.days, 0);
  const cutoffDate = new Date(Date.now() - graceDays * 86_400_000).toISOString().slice(0, 10);

  let q = ctx.db
    .from("tasks")
    .select("id, title, due_date")
    .eq("company_id", ctx.companyId)
    .in("status", ["todo", "in_progress"])
    .lt("due_date", cutoffDate)
    .not("due_date", "is", null)
    .is("deleted_at", null);
  // A personal watch sees only the owner's tasks (assigned to OR created by).
  if (isOwnerScoped(scope)) q = q.or(`assigned_to.eq.${scope.ownerId},created_by.eq.${scope.ownerId}`);
  const { data, error } = await q;
  if (error) throw new Error(`overdue_task evaluation failed: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; due_date: string }>;
  const pairs = rows.map((r) => ({ id: r.id, bucket: daysBucket(daysBetweenDates(r.due_date)) }));
  return {
    matched: rows.length > 0,
    rows: rows.map((r) => ({ id: r.id })),
    state_field: perRowState(pairs),
    brief: `${rows.length} overdue task${rows.length === 1 ? "" : "s"}`,
  };
};

// ── Expense helpers (income vs expense is the category's type) ──

async function expenseCategoryIds(
  ctx: ToolContext,
  restrictTo?: string
): Promise<string[]> {
  let q = ctx.db
    .from("financial_categories")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("type", "expense")
    .eq("archived", false)
    .is("deleted_at", null);
  if (restrictTo) q = q.eq("id", restrictTo);
  const { data, error } = await q;
  if (error) throw new Error(`expense category lookup failed: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/** Sum expense transactions (in cents) since fromDate, optionally one category. */
async function sumExpenseCents(
  ctx: ToolContext,
  fromDate: string,
  categoryId?: string
): Promise<number> {
  const catIds = await expenseCategoryIds(ctx, categoryId);
  if (catIds.length === 0) return 0;
  const { data, error } = await ctx.db
    .from("financial_transactions")
    .select("amount")
    .eq("company_id", ctx.companyId)
    .in("category_id", catIds)
    .gte("date", fromDate)
    .eq("archived", false)
    .eq("exclude_from_reports", false)
    .is("deleted_at", null);
  if (error) throw new Error(`expense sum failed: ${error.message}`);
  const dollars = ((data ?? []) as Array<{ amount: number | string }>).reduce(
    (acc, r) => acc + Math.abs(Number(r.amount)),
    0
  );
  return Math.round(dollars * 100);
}

/** Crossed-threshold step: how many multiples of the threshold we are over. */
function thresholdStep(totalCents: number, thresholdCents: number): number {
  if (thresholdCents <= 0) return 0;
  return Math.floor(totalCents / thresholdCents);
}

// ── overspend: expense in a rolling window vs a threshold ──

const overspend: DataEvaluator = async (ctx, params) => {
  const windowDays = asInt(params.window_days, 30);
  const thresholdCents = asInt(params.threshold_cents, 0);
  const categoryId = typeof params.category_id === "string" ? params.category_id : undefined;
  const fromDate = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const totalCents = await sumExpenseCents(ctx, fromDate, categoryId);
  const step = thresholdStep(totalCents, thresholdCents);
  return {
    matched: thresholdCents > 0 && totalCents >= thresholdCents,
    rows: [],
    state_field: `step:${step}`,
    brief: `Spend in the last ${windowDays} days is $${(totalCents / 100).toFixed(2)} (threshold $${(thresholdCents / 100).toFixed(2)})`,
  };
};

// ── budget_threshold: month-to-date category spend vs budget ──

const budget_threshold: DataEvaluator = async (ctx, params) => {
  const thresholdCents = asInt(params.threshold_cents, 0);
  const categoryId = typeof params.category_id === "string" ? params.category_id : undefined;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);

  const totalCents = await sumExpenseCents(ctx, monthStart, categoryId);
  const step = thresholdStep(totalCents, thresholdCents);
  return {
    matched: thresholdCents > 0 && totalCents >= thresholdCents,
    rows: [],
    state_field: `step:${step}`,
    brief: `Month-to-date spend${categoryId ? " in this category" : ""} is $${(totalCents / 100).toFixed(2)} (budget $${(thresholdCents / 100).toFixed(2)})`,
  };
};

// ── Registry ───────────────────────────────────────────────

export const dataEvaluators: Record<string, DataEvaluator> = {
  stalled_deal,
  stuck_task,
  overdue_task,
  overspend,
  budget_threshold,
};

/** condition_types that are evaluated server-side as data conditions. */
export const DATA_CONDITION_TYPES = Object.keys(dataEvaluators);
