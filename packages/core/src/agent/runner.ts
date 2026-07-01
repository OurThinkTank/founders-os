// ============================================================
// Founders OS — Headless Agent SDK runner core (T2.1)
// ============================================================
// The provider-neutral core of the Option B headless runner. The real
// runner (packages/mcp-server) drives the Claude Agent SDK, which hosts
// founders-os (in autonomous mode) and the user's connectors as MCP
// servers and runs the model loop. This module holds everything that is
// pure and testable without the SDK:
//
//   * buildRunnerMcpServers  — the mcpServers config (founders-os forced
//     into FOUNDERSOS_PRINCIPAL=autonomous + the run id, plus connectors).
//   * RUNNER_FOUNDERS_OS_TOOLS / runnerAllowedTools — the tool surface the
//     model may use, expressed as Agent SDK `mcp__<server>__<tool>` names.
//     This is the Layer 1 surface reduction for the MCP-hosted runner.
//   * makeRunnerCanUseTool — the permission callback factory. founders-os
//     allowlisted tools are allowed; any connector tool is routed to a
//     `connectorDecision` (T2.1 default: deny, so externals still stage;
//     T2.2 swaps in verify-clearance); everything else is denied.
//   * summarizeRunnerMessages / runAgentTick — accounting over a neutral
//     message stream, with the SDK call injected so tests need no SDK.
//
// The SDK itself is imported only in the mcp-server adapter, never here,
// so core carries no Agent SDK dependency.
// ============================================================

import { AGENT_TOOL_ALLOWLIST } from "./allowlist.js";

// ── Neutral types (mirror only what we depend on from the SDK) ──

/** A tool call observed in the runner's message stream. */
export interface RunnerToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Neutral runner message: only the shapes we account on. The mcp-server
 * adapter maps the Agent SDK's streamed messages onto these. */
export type RunnerMessage =
  | { type: "tool_use"; toolUse: RunnerToolUse }
  | { type: "tool_result"; toolUseId: string; isError: boolean }
  | { type: "result"; subtype: string };

/** The canUseTool decision, mirroring the SDK PermissionResult we adapt to. */
export type RunnerPermission =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** The permission callback the runner hands the SDK (adapted), narrowed to
 * the inputs we use. */
export type RunnerCanUseTool = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<RunnerPermission>;

// ── MCP server config ──────────────────────────────────────

export interface RunnerMcpStdioServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The mcpServers map handed to the Agent SDK. Connector entries are
 * passed through opaquely (stdio / http / sse — the SDK validates them). */
export type RunnerMcpServers = Record<string, RunnerMcpStdioServer | Record<string, unknown>>;

export interface BuildRunnerMcpOptions {
  runId: string;
  /** Command + args that launch the founders-os stdio MCP server. */
  serverCommand: string;
  serverArgs: string[];
  /** Env for the founders-os server (Supabase + identity). The runner forces
   * the autonomous principal + run id on top, so the hard gate arms. */
  serverEnv: Record<string, string>;
  /** Extra connector MCP servers (Slack, ...). Omitted/empty = stage-only. */
  connectors?: RunnerMcpServers;
}

export const FOUNDERS_OS_MCP_NAME = "founders-os";

/**
 * Build the mcpServers config. The founders-os entry is always present and
 * always autonomous: FOUNDERSOS_PRINCIPAL=autonomous + FOUNDERSOS_RUN_ID are
 * forced on (they win over any inherited value), which is what arms the
 * hard gate (T0.1). Connector servers are merged in as-is.
 */
export function buildRunnerMcpServers(opts: BuildRunnerMcpOptions): RunnerMcpServers {
  return {
    [FOUNDERS_OS_MCP_NAME]: {
      command: opts.serverCommand,
      args: opts.serverArgs,
      env: {
        ...opts.serverEnv,
        FOUNDERSOS_PRINCIPAL: "autonomous",
        FOUNDERSOS_RUN_ID: opts.runId,
      },
    },
    ...(opts.connectors ?? {}),
  };
}

// ── Tool surface (Layer 1 for the MCP-hosted runner) ───────

/** The founders-os tools the unattended runner may use: the autonomous
 * allowlist (reads + reversible native writes + preview_action), plus
 * resolve_trigger_fire so the model can mark each handled fire. Connector
 * tools are NOT listed here; they are gated by canUseTool so the
 * verify-clearance hook (T2.2) always runs for them. */
export const RUNNER_FOUNDERS_OS_TOOLS: readonly string[] = [
  ...AGENT_TOOL_ALLOWLIST,
  "resolve_trigger_fire",
  // The Agent SDK runner (unlike the frozen Phase 2b in-process loop) also gets
  // execute_action, so it can mint the single-use clearance the dispatch hook
  // verifies for auto-dispatch. Safe for the autonomous principal: execute_action's
  // clear-time hard gate refuses any action that resolves to hold_for_approval
  // (held + red tiers), so the runner can only clear what the policy already
  // auto-allows, and the connector send still requires the opt-in connector
  // policy plus the canUseTool hook. Kept OUT of AGENT_TOOL_ALLOWLIST so Phase 2b
  // stays stage-only (frozen, not extended).
  "execute_action",
];

/** The founders-os tool names as Agent SDK patterns (mcp__founders-os__x). */
export function foundersOsAllowedToolNames(): string[] {
  return RUNNER_FOUNDERS_OS_TOOLS.map((t) => `mcp__${FOUNDERS_OS_MCP_NAME}__${t}`);
}

/**
 * allowedTools for the SDK: the founders-os tools are auto-approved (they
 * are gate-governed internally). Connector tools are deliberately left OUT
 * so they fall through to canUseTool, where verify-clearance can run; an
 * allow rule here would short-circuit canUseTool (allow rules are evaluated
 * before it).
 */
export function runnerAllowedTools(): string[] {
  return foundersOsAllowedToolNames();
}

/** True for any MCP tool that is not a founders-os tool (i.e. a connector). */
export function isConnectorTool(toolName: string): boolean {
  return toolName.startsWith("mcp__") && !toolName.startsWith(`mcp__${FOUNDERS_OS_MCP_NAME}__`);
}

/** Parse a connector tool name `mcp__<connector>__<action>` into its parts.
 * Returns null for a founders-os tool or a non-MCP tool name. The connector
 * is the MCP server key; the action is the connector verb. */
export function parseConnectorTool(toolName: string): { connector: string; action: string } | null {
  if (!isConnectorTool(toolName)) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep < 0) return null;
  return { connector: rest.slice(0, sep), action: rest.slice(sep + 2) };
}

/**
 * Build the runner's permission callback.
 *   - a founders-os allowlisted tool: allow.
 *   - a connector tool: defer to `connectorDecision` (T2.1 default denies,
 *     so external actions still go through preview_action and stage; T2.2
 *     passes a verify-clearance decision here).
 *   - anything else (a non-allowlisted founders-os tool, a built-in): deny.
 */
export function makeRunnerCanUseTool(opts: {
  connectorDecision?: RunnerCanUseTool;
}): RunnerCanUseTool {
  const allowed = new Set(foundersOsAllowedToolNames());
  const connectorDecision: RunnerCanUseTool =
    opts.connectorDecision ??
    (async (toolName) => ({
      behavior: "deny",
      message:
        `Auto-dispatch is not enabled for ${toolName}. Stage the action with preview_action instead.`,
    }));

  return async (toolName, input) => {
    if (allowed.has(toolName)) return { behavior: "allow" };
    if (isConnectorTool(toolName)) return connectorDecision(toolName, input);
    return {
      behavior: "deny",
      message: `Tool ${toolName} is not permitted for the unattended runner.`,
    };
  };
}

// ── System + user prompt ───────────────────────────────────

export const RUNNER_SYSTEM_PROMPT =
  "You are the unattended Founders OS tick, triaging the watches that fired " +
  "while the founder was away. List the pending fires (list_trigger_fires), and " +
  "for EACH fire choose one move: create_task for an actionable follow-up the " +
  "founder should do; notify_inbox for a pure heads-up; or preview_action for " +
  "anything that touches the outside world (Slack, email, payments). Read context " +
  "first when useful (get_task, list_tasks, get_entity_card, memory_recall). Never " +
  "assume facts you cannot see. When you are unsure whether to act at all, prefer a " +
  "heads-up or staging over acting. After handling a fire, mark it with " +
  "resolve_trigger_fire. When no pending fires remain, stop.\n\n" +
  "EXTERNAL ACTIONS — THE GATE. Every action on the outside world goes through the " +
  "gate, and you must follow its decision rather than assume the action is staged. " +
  "Call preview_action with kind 'external', connector set to the MCP server name " +
  "(e.g. 'slack'), action set to the EXACT connector tool name you will call " +
  "(e.g. 'slack_send_message', NOT 'send_message'), and params set to EXACTLY the " +
  "fields that connector tool takes (e.g. channel_id and message). Then act on the " +
  "returned outcome:\n" +
  "- allow or allow_with_log: you are authorized to complete it NOW. Call " +
  "execute_action with the confirm_token and the same resolved action, then call the " +
  "connector's own tool (e.g. mcp__slack__slack_send_message) with the IDENTICAL " +
  "params you just cleared. Do not change, add, or drop a single field between " +
  "clearing and sending — the send is permitted only when its parameters match the " +
  "cleared ones exactly. Do not treat allow_with_log as staged; it means send.\n" +
  "- hold_for_approval, staged_for_deferred_approval, or paused: STOP. The action is " +
  "queued for the founder to approve later; do NOT call the connector tool.\n" +
  "Never call a connector tool without first clearing the exact same call through " +
  "preview_action and execute_action.";

export const RUNNER_USER_PROMPT =
  "Process the pending trigger fires now. Handle each one, then stop.";

// ── Accounting ─────────────────────────────────────────────

export interface RunnerSummary {
  /** Total tool calls the model made. */
  toolCalls: number;
  /** Internal records created (create_task / add_task_note / notify_inbox). */
  created: number;
  /** External actions staged via preview_action. */
  staged: number;
  /** Fires marked handled via resolve_trigger_fire. */
  resolved: number;
  /** Tool calls that returned an error result. */
  errors: number;
}

const CREATE_TOOLS = new Set(["create_task", "add_task_note", "notify_inbox"]);

/** Strip the mcp__<server>__ prefix to the bare tool name, for categorizing.
 * Splits on the first "__" after the "mcp__" prefix, so a server name with a
 * hyphen (founders-os) is handled correctly. */
function bareToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep >= 0 ? rest.slice(sep + 2) : name;
}

/**
 * Accounting over the neutral message stream. Categorizes by tool name
 * (a scaffold-level summary: it counts a preview_action call as "staged"
 * without parsing its outcome; T2.x can refine from the tool_result). */
export function summarizeRunnerMessages(messages: Iterable<RunnerMessage>): RunnerSummary {
  let toolCalls = 0;
  let created = 0;
  let staged = 0;
  let resolved = 0;
  let errors = 0;

  for (const m of messages) {
    if (m.type === "tool_use") {
      toolCalls++;
      const name = bareToolName(m.toolUse.name);
      if (CREATE_TOOLS.has(name)) created++;
      else if (name === "preview_action") staged++;
      else if (name === "resolve_trigger_fire") resolved++;
    } else if (m.type === "tool_result" && m.isError) {
      errors++;
    }
  }

  return { toolCalls, created, staged, resolved, errors };
}

// ── Orchestrator (SDK call injected) ───────────────────────

export interface RunAgentTickOptions {
  mcpServers: RunnerMcpServers;
  allowedTools: string[];
  systemPrompt: string;
  prompt: string;
  canUseTool: RunnerCanUseTool;
  maxTurns?: number;
  model?: string;
}

/** The injected SDK boundary: yields neutral RunnerMessages for one run.
 * The mcp-server adapter implements this over the Agent SDK query(); tests
 * pass a fake that yields a scripted stream. */
export type RunnerQuery = (opts: RunAgentTickOptions) => AsyncIterable<RunnerMessage>;

/**
 * Run one headless tick: stream the model session to completion and return
 * the accounting summary. All policy (the gate, staging, verify-clearance)
 * lives behind the MCP boundary and canUseTool; this function only drives
 * the loop and counts.
 */
export async function runAgentTick(
  opts: RunAgentTickOptions,
  runQuery: RunnerQuery
): Promise<RunnerSummary> {
  const messages: RunnerMessage[] = [];
  for await (const m of runQuery(opts)) messages.push(m);
  return summarizeRunnerMessages(messages);
}
