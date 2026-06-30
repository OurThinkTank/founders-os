// ============================================================
// Founders OS — Verify-clearance dispatch hook (T2.2)
// ============================================================
// The connectorDecision the headless runner's canUseTool callback uses to
// gate an unattended connector write. This is what turns the Agent SDK
// permission callback into a real chokepoint (Option B, B-ii):
//
//   The model calls preview_action then execute_action for an external
//   action, which records a single-use clearance (T0.2). When the model
//   then calls the connector's MCP tool, this decision reconstructs the
//   ProposedAction from the tool call, recomputes the SAME content hash the
//   gate stamped, and asks verifyAndConsumeClearance to atomically consume a
//   matching 'cleared' clearance. Allowed exactly once; a replay, a
//   bait-and-switch (different params -> different hash), an unconfigured
//   connector, or an expired clearance are all denied.
//
// The decision needs a ToolContext with DB access; the runner builds an
// autonomous context for it (the founders-os MCP subprocess the runner
// also launches writes the clearances against the same company + table).
// ============================================================

import type { ToolContext } from "../types/context.js";
import type { ProposedAction } from "../tools/playbooks/risk.js";
import { actionHash, verifyAndConsumeClearance } from "../tools/governance/index.js";
import { recordDispatchFinding } from "../tools/governance/reconcile.js";
import { parseConnectorTool, type RunnerCanUseTool } from "./runner.js";
import { checkConnectorCapability, type ConnectorPolicy } from "./connector-policy.js";

/**
 * Build the connectorDecision backed by verify-clearance. Pass it to
 * makeRunnerCanUseTool({ connectorDecision }). It only ever sees connector
 * tools (founders-os tools are handled before it).
 *
 * Order of checks, all of which must pass to allow a connector write:
 *   1. capability + scope (T2.3): when a `policy` is supplied, the connector
 *      must be enabled, the verb allowlisted, and the target scope (e.g. a
 *      Slack channel) permitted. Checked FIRST so a policy-denied call never
 *      consumes a clearance. With no policy, this step is skipped (the
 *      clearance-only behaviour from T2.2).
 *   2. fresh clearance (T2.2): a `cleared` clearance for the EXACT action
 *      (content hash) is atomically consumed, so the write runs at most once
 *      and a bait-and-switch is refused.
 */
export function makeVerifyClearanceDecision(
  ctx: ToolContext,
  opts: { policy?: ConnectorPolicy } = {}
): RunnerCanUseTool {
  return async (toolName, input) => {
    const parsed = parseConnectorTool(toolName);
    if (!parsed) {
      return { behavior: "deny", message: `Cannot identify the connector for ${toolName}.` };
    }

    if (opts.policy) {
      const cap = checkConnectorCapability(opts.policy, parsed.connector, parsed.action, input);
      if (!cap.ok) {
        return { behavior: "deny", message: `Not permitted: ${cap.reason}.` };
      }
    }

    const action: ProposedAction = {
      kind: "external",
      connector: parsed.connector,
      action: parsed.action,
      params: input,
      summary: null,
    };
    const hash = actionHash(action);

    const result = await verifyAndConsumeClearance(ctx, {
      connector: parsed.connector,
      actionHash: hash,
    });

    if (result.allowed) {
      // Reconcile-at-dispatch (T2.4): record the governed send now, matched
      // to the clearance just consumed, so no later fetch-and-diff is needed.
      if (result.jti) {
        await recordDispatchFinding(ctx, {
          connector: parsed.connector,
          jti: result.jti,
          summary: `Auto-dispatched ${parsed.connector} ${parsed.action}`,
        });
      }
      return { behavior: "allow" };
    }
    return {
      behavior: "deny",
      message:
        `No fresh clearance for this ${parsed.connector} action (${result.reason}). ` +
        "Run preview_action then execute_action for the exact same action first; " +
        "the cleared parameters must match what you send.",
    };
  };
}
