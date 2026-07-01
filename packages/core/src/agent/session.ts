// ============================================================
// Founders OS — Agent SDK session: safety posture (T2.5)
// ============================================================
// Brings the Agent SDK runner up to runFull's defensive posture, and owns
// the bits that must not live in the SDK adapter:
//
//   * Pause kill switch: a paused company runs nothing.
//   * Per-company run lock: reuses acquire_agent_run_lock (migration 041), so
//     the Agent SDK runner and the frozen in-process runFull never both drive
//     the same backlog; the lock is released on the way out.
//   * Send accounting + budget: builds the canUseTool with onAllow/budgetReached
//     closures, so `sent` is counted and connector writes are refused once the
//     run's send budget is spent.
//
// Per-fire isolation differs from runFull by design: this runner drives one
// model session that drains the inbox, so a single bad fire is handled by the
// model (it sees the tool error and moves on) rather than an explicit per-fire
// loop. A catastrophic session failure is caught by the caller (tick.ts).
//
// The SDK call is injected (RunnerQuery) so this is unit-testable with no SDK.
// ============================================================

import type { ToolContext } from "../types/context.js";
import { loadPolicy } from "../tools/governance/policy.js";
import { makeRunnerCanUseTool, runAgentTick, type RunnerMcpServers, type RunnerQuery } from "./runner.js";
import { makeVerifyClearanceDecision } from "./clearance-hook.js";
import type { ConnectorPolicy } from "./connector-policy.js";

const RUN_LOCK_TTL_SECONDS = 3600;
const DEFAULT_MAX_SENDS = 20;

export interface RunAgentSessionConfig {
  mcpServers: RunnerMcpServers;
  allowedTools: string[];
  systemPrompt: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  /** Cap on connector dispatches (sends) this run. Default 20. */
  maxSends?: number;
  /** Per-connector auto-dispatch policy (verbs + scopes). */
  policy?: ConnectorPolicy;
  runLockTtlSeconds?: number;
}

export interface AgentSessionResult {
  /** Agents are paused company-wide; nothing ran. */
  paused: boolean;
  /** Another run held the company lock; nothing ran. */
  locked_out: boolean;
  /** Connector dispatches performed (allowed by the hook). */
  sent: number;
  /** Internal records created (create_task / add_task_note / notify_inbox). */
  created: number;
  /** External actions staged via preview_action. */
  staged: number;
  /** Fires marked handled via resolve_trigger_fire. */
  resolved: number;
  /** Tool calls that returned an error result. */
  errors: number;
  /** True when the send budget was hit and further sends were refused. */
  budget_exhausted: boolean;
}

const ZERO = { sent: 0, created: 0, staged: 0, resolved: 0, errors: 0, budget_exhausted: false };

/**
 * Run one headless Agent SDK session behind the pause check, the run lock,
 * and the send budget, and return the accounting. Performs no external side
 * effect itself: the gate, staging, and verify-clearance live behind the MCP
 * boundary and the canUseTool hook this builds.
 */
export async function runAgentSession(
  ctx: ToolContext,
  config: RunAgentSessionConfig,
  runQuery: RunnerQuery
): Promise<AgentSessionResult> {
  // 1. Pause kill switch: if agents are paused company-wide, do nothing.
  const policy = await loadPolicy(ctx);
  if (policy.paused) {
    return { paused: true, locked_out: false, ...ZERO };
  }

  // 2. Per-company run lock: refuse to overlap another tick (which would
  //    double-process and double-spend). A stale lock self-heals via the TTL.
  const runId = ctx.actor && ctx.actor.kind === "autonomous" ? ctx.actor.runId : "run";
  const { data: acquired, error: lockErr } = await ctx.db.rpc("acquire_agent_run_lock", {
    p_company_id: ctx.companyId,
    p_run_id: runId,
    p_ttl_seconds: config.runLockTtlSeconds ?? RUN_LOCK_TTL_SECONDS,
  });
  if (lockErr) throw new Error(`Failed to acquire run lock: ${lockErr.message}`);
  if (!acquired) {
    return { paused: false, locked_out: true, ...ZERO };
  }

  try {
    // 3. Send accounting + budget, enforced at the hook. onAllow counts each
    //    dispatch; budgetReached refuses connector writes past the cap.
    const maxSends = config.maxSends ?? DEFAULT_MAX_SENDS;
    let sent = 0;
    let budgetExhausted = false;
    const decision = makeVerifyClearanceDecision(ctx, {
      policy: config.policy,
      onAllow: () => {
        sent += 1;
      },
      budgetReached: () => {
        if (sent >= maxSends) {
          budgetExhausted = true;
          return true;
        }
        return false;
      },
    });
    const canUseTool = makeRunnerCanUseTool({ connectorDecision: decision });

    const summary = await runAgentTick(
      {
        mcpServers: config.mcpServers,
        allowedTools: config.allowedTools,
        systemPrompt: config.systemPrompt,
        prompt: config.prompt,
        canUseTool,
        maxTurns: config.maxTurns,
        model: config.model,
      },
      runQuery
    );

    return {
      paused: false,
      locked_out: false,
      sent,
      created: summary.created,
      staged: summary.staged,
      resolved: summary.resolved,
      errors: summary.errors,
      budget_exhausted: budgetExhausted,
    };
  } finally {
    // Release our lock so the next scheduled tick can run immediately. Scoped
    // to our run_id so we never delete a lock a later run stole after a crash.
    await ctx.db.from("agent_run_locks").delete().eq("company_id", ctx.companyId).eq("run_id", runId);
  }
}
