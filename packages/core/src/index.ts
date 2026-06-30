// ============================================================
// @ourthinktank/founders-os-core
// ============================================================
// Transport-agnostic core surface for Founders OS.
//
// The critical export is the set of raw ToolMaps: a non-stdio wrapper
// (e.g. an MCP-over-HTTP host) can bind these directly to its own
// transport, instead of being forced through register*Tools(server, ctx),
// which assume an McpServer. The register*Tools convenience functions are
// also exported for the stdio wrapper that ships in @ourthinktank/founders-os.
// ============================================================

// ---- Tool contract ----
export { registerToolMap, callTool } from "./tools/register.js";
export type {
  ToolMap,
  ToolDefinition,
  LegacyHandler,
  ContextualHandler,
} from "./tools/register.js";

// ---- Context construction + Supabase ----
export {
  buildContext,
  buildAutonomousContext,
  readEmbeddingConfigFromEnv,
  readAgentModelConfigFromEnv,
} from "./context.js";
export { createServiceClient } from "./supabase.js";

// ---- Rendering contract ----
export {
  RENDERING_CONTRACT,
  RENDERING_CONTRACT_SHORT,
  RENDERING_CONTRACT_VERSION,
  COLOR_CONVENTIONS,
} from "./contract.js";

// ---- Database schema version ----
export { EXPECTED_SCHEMA_VERSION } from "./schema-version.js";

// ---- First-run detection ----
export { detectFirstRun, FIRST_RUN_HINT } from "./tools/first-run.js";

// ---- Identity helpers ----
export {
  getUserId,
  getCompanyId,
  isSoloMode,
  isPlaceholderIdentity,
  getPlaceholderIdentityHint,
  DEFAULT_USER_ID,
  DEFAULT_COMPANY_ID,
} from "./utils/identity.js";

// ---- Shared types ----
export type {
  ToolContext,
  EmbeddingConfig,
  AgentModelConfig,
  IdentityMode,
  Actor,
} from "./types/context.js";
export { isAutonomous } from "./types/context.js";
export type {
  Render,
  FormatHint,
  RenderInstructions,
  RenderTier1,
  RenderTier2,
  RenderTier3,
} from "./types/render.js";

// ============================================================
// Raw tool maps — the transport-agnostic surface
// ============================================================
export { taskTools } from "./tools/tasks/index.js";
export { tagTools } from "./tools/tags/index.js";
export { memoryTools } from "./tools/memory/index.js";
export { financialTools } from "./tools/financial/index.js";
export { financialManagementTools } from "./tools/financial/management.js";
export { memberTools } from "./tools/members/index.js";
export { surfaceTools } from "./tools/surfaces/index.js";
export { playbookTools } from "./tools/playbooks/index.js";
export { governanceTools } from "./tools/governance/index.js";
export { triggerTools } from "./tools/triggers/index.js";
export { notificationTools } from "./tools/notifications/index.js";
export { evaluateDataTriggers } from "./tools/triggers/evaluate.js";
export { runHoldOnly } from "./tools/run/hold-only.js";
export type { HoldOnlyResult } from "./tools/run/hold-only.js";
export { runFull } from "./tools/run/full.js";
export type { FullRunResult } from "./tools/run/full.js";
export {
  getAgentModel,
  MockAgentModel,
  AnthropicAgentModel,
  OpenAIAgentModel,
  _resetAgentModelForTesting,
} from "./agent/model.js";
export type {
  AgentModel,
  AgentTool,
  AgentMessage,
  AgentToolCall,
  AgentTurn,
} from "./agent/model.js";
export {
  AGENT_TOOL_ALLOWLIST,
  buildAgentToolRegistry,
  buildAgentTools,
} from "./agent/allowlist.js";
export type { AgentToolName } from "./agent/allowlist.js";
export {
  FOUNDERS_OS_MCP_NAME,
  RUNNER_FOUNDERS_OS_TOOLS,
  RUNNER_SYSTEM_PROMPT,
  RUNNER_USER_PROMPT,
  buildRunnerMcpServers,
  foundersOsAllowedToolNames,
  runnerAllowedTools,
  isConnectorTool,
  parseConnectorTool,
  makeRunnerCanUseTool,
  summarizeRunnerMessages,
  runAgentTick,
} from "./agent/runner.js";
export { makeVerifyClearanceDecision } from "./agent/clearance-hook.js";
export type {
  RunnerToolUse,
  RunnerMessage,
  RunnerPermission,
  RunnerCanUseTool,
  RunnerMcpStdioServer,
  RunnerMcpServers,
  BuildRunnerMcpOptions,
  RunnerSummary,
  RunAgentTickOptions,
  RunnerQuery,
} from "./agent/runner.js";
export type {
  DataFire,
  EvaluateDataResult,
  EvaluateDataOptions,
} from "./tools/triggers/evaluate.js";
export { projectTools } from "./tools/projects/index.js";
export { restoreTools } from "./tools/restore.js";
export { crmTools } from "./tools/crm/index.js";
export { rssTools } from "./tools/rss/index.js";

// Granular sub-maps (for wrappers that bind a subset)
export {
  customerTools,
} from "./tools/crm/customers.js";
export { contactTools } from "./tools/crm/contacts.js";
export { interactionTools } from "./tools/crm/interactions.js";
export { dashboardTools } from "./tools/crm/dashboard.js";
export { feedTools } from "./tools/rss/feeds.js";
export { itemTools } from "./tools/rss/items.js";
export { bookmarkTools } from "./tools/rss/bookmarks.js";
export { briefingTools } from "./tools/rss/briefing.js";

// ============================================================
// register*Tools convenience functions (McpServer-bound)
// ============================================================
export { registerCRMTools } from "./tools/crm/index.js";
export { registerTaskTools } from "./tools/tasks/index.js";
export { registerTagTools } from "./tools/tags/index.js";
export { registerMemoryTools } from "./tools/memory/index.js";
export { registerFinancialTools } from "./tools/financial/index.js";
export { registerFinancialManagementTools } from "./tools/financial/management.js";
export { registerMemberTools } from "./tools/members/index.js";
export { registerRSSTools } from "./tools/rss/index.js";
export { registerSurfaceTools } from "./tools/surfaces/index.js";
export { registerPlaybookTools } from "./tools/playbooks/index.js";
export { registerGovernanceTools, approveAction, bulkApproveActions, verifyAndConsumeClearance, actionHash } from "./tools/governance/index.js";
export { registerTriggerTools } from "./tools/triggers/index.js";
export { registerNotificationTools } from "./tools/notifications/index.js";
export { registerProjectTools } from "./tools/projects/index.js";
export { registerRestoreTools } from "./tools/restore.js";
