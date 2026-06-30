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
import { parseConnectorTool, type RunnerCanUseTool } from "./runner.js";

/**
 * Build the connectorDecision backed by verify-clearance. Pass it to
 * makeRunnerCanUseTool({ connectorDecision }). It only ever sees connector
 * tools (founders-os tools are handled before it); it allows a connector
 * write solely when a fresh clearance for the exact action exists, and
 * consumes that clearance so the same write cannot run twice.
 */
export function makeVerifyClearanceDecision(ctx: ToolContext): RunnerCanUseTool {
  return async (toolName, input) => {
    const parsed = parseConnectorTool(toolName);
    if (!parsed) {
      return { behavior: "deny", message: `Cannot identify the connector for ${toolName}.` };
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

    if (result.allowed) return { behavior: "allow" };
    return {
      behavior: "deny",
      message:
        `No fresh clearance for this ${parsed.connector} action (${result.reason}). ` +
        "Run preview_action then execute_action for the exact same action first; " +
        "the cleared parameters must match what you send.",
    };
  };
}
