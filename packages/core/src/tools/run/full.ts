// ============================================================
// Founders OS — Autonomous runner: full (model-driven) mode
// ============================================================
// The model-driven core of `founders-os-tick run --execute`. A sibling
// of runHoldOnly with the SAME defensive posture: pause check first,
// per-fire isolation, collect errors, never throw. The difference is
// judgment: instead of staging every fire identically, a model reads
// each fire and decides the right internal follow-up (create_task /
// add_task_note / notify_inbox) or stages an external action for human
// approval (preview_action).
//
// Safety, by construction (see headless-agent-implementation-plan.md):
//   * Layer 1 — the model only ever sees the small allowlist
//     (buildAgentTools); execute_action, remove_*/purge_*, set_policy,
//     pause_agents and approve_action are not in the map it is handed.
//   * Layer 2 — ctx is the autonomous principal, so preview_action floors
//     every hold at staged_for_deferred_approval. The model literally
//     cannot execute a hold: there is no execute path here.
//   * Layer 3 — the only writes are native (allow_with_log, no token) and
//     preview_action (stages, no side effect). No egress function exists.
//
// Per-fire conversation, NOT one giant conversation, so each fire is
// bounded and one bad fire cannot starve the rest. A global maxActions
// budget caps total writes across the run; maxStepsPerFire caps the
// model<->tool loop within a single fire.
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import type { AgentMessage, AgentModel } from "../../agent/model.js";
import { getAgentModel } from "../../agent/model.js";
import {
  buildAgentTools,
  buildAgentToolRegistry,
  isAgentWriteTool,
} from "../../agent/allowlist.js";
import { callTool } from "../register.js";
import { loadPolicy } from "../governance/policy.js";

interface TriggerFireRow {
  id: string;
  trigger_id: string;
  condition_type: string;
  brief: string;
  action: Record<string, unknown> | null;
  status: string;
}

export interface FullRunResult {
  /** Pending inbox fires seen this run. */
  scanned: number;
  /** Internal records the model created (create_task/add_task_note/notify_inbox). */
  created: number;
  /** External actions staged for human approval (preview_action). */
  staged: number;
  /** Fires the model processed without taking any write action. */
  skipped: number;
  /** True when the company-wide kill switch is on; the run did nothing. */
  paused: boolean;
  /** True when another run held the company run lock; this run did nothing. */
  locked_out: boolean;
  /** True when the global action budget was exhausted mid-run. */
  budget_exhausted: boolean;
  /** Per-fire failures (isolated, not fatal). */
  errors: Array<{ fire_id: string; error: string }>;
}

/** Run-lock TTL: longer than any plausible run, so a crash self-heals next tick. */
const RUN_LOCK_TTL_SECONDS = 3600;

const SYSTEM_PROMPT =
  "You are triaging the watches that fired while the founder was away. " +
  "For each fire, choose one of three moves: create_task for an actionable " +
  "follow-up the founder should do; notify_inbox for a pure heads-up the " +
  "founder should see but that needs no task; or preview_action to stage " +
  "anything that touches the outside world (email, Slack, payments) for the " +
  "founder to approve. You may first read context (get_task, list_tasks, " +
  "get_entity_card, memory_recall) to decide. Never assume facts you cannot " +
  "see. Prefer staging over acting when unsure. When you have handled the " +
  "fire, stop.";

/** Render a single fire as the opening user message for its conversation. */
function fireToPrompt(fire: TriggerFireRow): string {
  const action = fire.action && Object.keys(fire.action).length ? JSON.stringify(fire.action) : "(none)";
  return [
    "A watch fired while the founder was away.",
    `Condition: ${fire.condition_type}`,
    `What happened: ${fire.brief}`,
    `Prepared action from the watch: ${action}`,
    "Decide the right follow-up using the available tools.",
  ].join("\n");
}

/** Best-effort outcome parse of a callTool result for accounting only. */
function parseOutcome(json: string): { isError: boolean; outcome?: string } {
  try {
    const v = JSON.parse(json) as { isError?: boolean; outcome?: string };
    return { isError: v.isError === true, outcome: v.outcome };
  } catch {
    return { isError: false };
  }
}

/**
 * Drain the inbox in full (model-driven) mode. Respects the pause kill
 * switch, then for each pending fire runs a bounded model<->tool loop over
 * the allowlist, marking the fire acted when done. Performs no external
 * side effect: preview_action stages, native writes are reversible, and
 * there is no execute path. Per-fire failures are collected, never thrown.
 */
export async function runFull(
  ctx: ToolContext,
  opts: {
    maxActions?: number;
    maxStepsPerFire?: number;
    limit?: number;
    /** Inject a model in tests; otherwise built from ctx.agentModel. */
    model?: AgentModel;
  } = {}
): Promise<FullRunResult> {
  // Kill switch: if agents are paused company-wide, do nothing at all.
  const policy = await loadPolicy(ctx);
  if (policy.paused) {
    return {
      scanned: 0, created: 0, staged: 0, skipped: 0,
      paused: true, locked_out: false, budget_exhausted: false, errors: [],
    };
  }

  // A model is required for full run. Absence means the runner should never
  // have reached here (tick.ts gates on config presence); fail loud.
  const model = opts.model ?? (ctx.agentModel ? getAgentModel(ctx.agentModel) : undefined);
  if (!model) {
    throw new Error(
      "runFull requires an agent model, but ctx.agentModel is not configured. " +
        "Set FOUNDERSOS_AGENT_PROVIDER (and a model + key) before --execute."
    );
  }

  // Per-company run lock: if another tick is already driving the model over
  // this backlog, do nothing rather than double-process (and double-spend).
  // A stale lock (older than the TTL, e.g. from a crashed run) is stolen.
  const runId = ctx.actor && ctx.actor.kind === "autonomous" ? ctx.actor.runId : "run";
  const { data: acquired, error: lockErr } = await ctx.db.rpc("acquire_agent_run_lock", {
    p_company_id: ctx.companyId,
    p_run_id: runId,
    p_ttl_seconds: RUN_LOCK_TTL_SECONDS,
  });
  if (lockErr) throw new Error(`Failed to acquire run lock: ${lockErr.message}`);
  if (!acquired) {
    return {
      scanned: 0, created: 0, staged: 0, skipped: 0,
      paused: false, locked_out: true, budget_exhausted: false, errors: [],
    };
  }

  try {
    return await drainInbox(ctx, model, opts);
  } finally {
    // Release our lock so the next scheduled tick can run immediately.
    // Scoped to our run_id so we never delete a lock the TTL handed to a
    // later run that stole it after a crash.
    await ctx.db
      .from("agent_run_locks")
      .delete()
      .eq("company_id", ctx.companyId)
      .eq("run_id", runId);
  }
}

/**
 * The lock-protected core: drain the pending inbox with the model. Split
 * from runFull so the lock acquire/release brackets exactly this work.
 */
async function drainInbox(
  ctx: ToolContext,
  model: AgentModel,
  opts: { maxActions?: number; maxStepsPerFire?: number; limit?: number }
): Promise<FullRunResult> {
  const maxActions = opts.maxActions ?? 20;
  const maxStepsPerFire = opts.maxStepsPerFire ?? 4;

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

  const tools = buildAgentTools();
  const registry = buildAgentToolRegistry();

  const a = ctx.actor;
  const actedBy = a && a.kind === "autonomous" ? `autonomous-run:${a.runId}` : "autonomous-run";

  let created = 0;
  let staged = 0;
  let skipped = 0;
  let actionsRemaining = maxActions;
  let budgetExhausted = false;
  const errors: Array<{ fire_id: string; error: string }> = [];

  for (const fire of fires) {
    try {
      const messages: AgentMessage[] = [{ role: "user", content: fireToPrompt(fire) }];
      let fireDidWrite = false;

      for (let step = 0; step < maxStepsPerFire; step++) {
        const turn = await model.turn({ system: SYSTEM_PROMPT, messages, tools });
        if (!turn.toolCalls.length) break; // model is done with this fire

        // Echo the assistant turn (text + tool_use) so the following
        // tool_result messages reference real tool calls.
        messages.push({ role: "assistant", content: turn.text, toolCalls: turn.toolCalls });

        for (const call of turn.toolCalls) {
          const def = (registry as Record<string, (typeof registry)[keyof typeof registry]>)[call.name];
          if (!def) {
            // Not in the allowlist: never dispatch. Tell the model and move on.
            messages.push({
              role: "tool_result",
              toolCallId: call.id,
              content: JSON.stringify({ error: `Tool "${call.name}" is not available.`, isError: true }),
            });
            continue;
          }

          const isWrite = isAgentWriteTool(call.name);
          if (isWrite && actionsRemaining <= 0) {
            // Global budget spent: refuse the write (do not dispatch), tell
            // the model, and stop this fire's loop. Reads would still be
            // allowed but there is nothing left to act on.
            budgetExhausted = true;
            messages.push({
              role: "tool_result",
              toolCallId: call.id,
              content: JSON.stringify({ error: "Action budget exhausted for this run.", isError: true }),
            });
            break;
          }

          const result = await callTool(ctx, def, call.input);
          messages.push({ role: "tool_result", toolCallId: call.id, content: result });

          if (isWrite) {
            actionsRemaining--;
            const { isError, outcome } = parseOutcome(result);
            if (!isError) {
              fireDidWrite = true;
              if (call.name === "preview_action") {
                if (outcome === "staged_for_deferred_approval") staged++;
              } else {
                created++;
              }
            }
          }
        }

        if (budgetExhausted) break;
      }

      if (!fireDidWrite) skipped++;

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

  return {
    scanned: fires.length,
    created,
    staged,
    skipped,
    paused: false,
    locked_out: false,
    budget_exhausted: budgetExhausted,
    errors,
  };
}
