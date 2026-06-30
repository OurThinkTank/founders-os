// ============================================================
// Founders OS — Headless agent tool allowlist (Layer 1)
// ============================================================
// The headless runner does NOT hand the model the ~130 registered
// tools. It exposes a small, explicit, hardcoded allowlist. This is the
// simplest realization of the design's default-deny allowlist, and it
// doubles as prompt-surface reduction.
//
// What this buys for free (see headless-agent-implementation-plan.md
// Part 3): no execute_action, no remove_*/purge_*, no set_policy /
// pause_agents / approve_action are reachable, because those tools are
// simply not in the map the model is handed. A run cannot delete, cannot
// self-approve, cannot unpause, cannot touch money. The failure mode is
// always "did not act", never "acted unreviewed". Adding a tool to this
// array is the audited guardrail-policy change the design calls for.
//
// The two internal write verbs are deliberately distinct: create_task is
// for actionable follow-ups, notify_inbox is a pure heads-up. preview_action
// stages any external action (hold tier => staged_for_deferred_approval for
// the autonomous principal), and is never executed because execute_action is
// absent from the map.
// ============================================================

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition, ToolMap } from "../tools/register.js";
import type { AgentTool } from "./model.js";

import { triggerTools } from "../tools/triggers/index.js";
import { taskTools } from "../tools/tasks/index.js";
import { surfaceTools } from "../tools/surfaces/index.js";
import { memoryTools } from "../tools/memory/index.js";
import { notificationTools } from "../tools/notifications/index.js";
import { governanceTools } from "../tools/governance/index.js";

/**
 * The first-cut allowlist. Order: reads/context, then internal writes,
 * then the external-staging gate. Keep this list and SOURCE_MAPS in sync.
 */
export const AGENT_TOOL_ALLOWLIST = [
  // read / context
  "list_trigger_fires",
  "get_task",
  "list_tasks",
  "get_entity_card",
  "memory_recall",
  // internal write
  "create_task",
  "add_task_note",
  "notify_inbox",
  // stage external (hold tier => staged_for_deferred_approval, no execution)
  "preview_action",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_ALLOWLIST)[number];

/**
 * The allowlisted tools that take an action (consume the runner's
 * global maxActions budget). The internal writes create reversible
 * records; preview_action stages an external action for human review.
 * Everything else in the allowlist is a read and is unbudgeted.
 */
export const AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_task",
  "add_task_note",
  "notify_inbox",
  "preview_action",
]);

/** True when a tool call should decrement the runner's action budget. */
export function isAgentWriteTool(name: string): boolean {
  return AGENT_WRITE_TOOLS.has(name);
}

/**
 * The domain ToolMaps the allowlist draws from. Earlier maps win on the
 * (unexpected) event of a duplicate tool name; buildAgentToolRegistry
 * asserts every allowlisted name resolves, so a rename in any domain
 * fails loudly here rather than silently dropping a tool from the agent.
 */
const SOURCE_MAPS: ToolMap[] = [
  triggerTools,
  taskTools,
  surfaceTools,
  memoryTools,
  notificationTools,
  governanceTools,
];

function lookup(name: string): ToolDefinition | undefined {
  for (const map of SOURCE_MAPS) {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
  }
  return undefined;
}

/**
 * Resolve the allowlist to a name -> ToolDefinition registry the runner
 * dispatches through (via callTool). Throws if any allowlisted name is
 * missing from the source maps, so a tool rename cannot silently shrink
 * the agent's capability set.
 */
export function buildAgentToolRegistry(): Record<AgentToolName, ToolDefinition> {
  const registry = {} as Record<AgentToolName, ToolDefinition>;
  const missing: string[] = [];
  for (const name of AGENT_TOOL_ALLOWLIST) {
    const def = lookup(name);
    if (!def) {
      missing.push(name);
      continue;
    }
    registry[name] = def;
  }
  if (missing.length) {
    throw new Error(
      `Agent allowlist references tools missing from the source maps: ${missing.join(", ")}. ` +
        `A tool was renamed or moved; update AGENT_TOOL_ALLOWLIST / SOURCE_MAPS.`
    );
  }
  return registry;
}

/**
 * Build the AgentTool[] the model sees: each allowlisted tool's Zod
 * parameters converted to self-contained JSON Schema. Refs are inlined
 * ($refStrategy: "none") so each tool's inputSchema stands alone, which
 * the model tool-use APIs expect.
 */
export function buildAgentTools(): AgentTool[] {
  const registry = buildAgentToolRegistry();
  return AGENT_TOOL_ALLOWLIST.map((name) => {
    const def = registry[name];
    const inputSchema = zodToJsonSchema(def.parameters, {
      $refStrategy: "none",
    }) as object;
    return { name, description: def.description, inputSchema };
  });
}
