// ============================================================
// Founders OS - Context Builder (self-hosted)
// ============================================================
// buildContext() reads the env vars that today's stdio MCP server
// uses and produces a single ToolContext for the process lifetime.
//
// In the eventual hosted-server wrapper, an equivalent builder
// runs per request and constructs a JWT-scoped context instead.
// Both call sites converge on the same ToolContext shape so the
// tools themselves do not change.
//
// See docs/multi-deployment-architecture.md.
// ============================================================

import { randomUUID } from "node:crypto";
import { createServiceClient } from "./supabase.js";
import { getCompanyId, getUserId, isSoloMode } from "./utils/identity.js";
import type {
  AgentModelConfig,
  EmbeddingConfig,
  ToolContext,
} from "./types/context.js";

let cached: ToolContext | null = null;

/**
 * Read embedding configuration from EMBEDDING_* env vars.
 *
 * Defaults:
 *   provider  = openai
 *   model     = provider-specific
 *   dimensions = provider-specific
 *   rate-limit = 30 calls per 60s
 *
 * Exported so memory-tools tests can rebuild the env-driven config
 * after toggling process.env in test isolation.
 */
export function readEmbeddingConfigFromEnv(): EmbeddingConfig {
  const providerName = (
    process.env.EMBEDDING_PROVIDER ?? "openai"
  ).toLowerCase() as EmbeddingConfig["provider"];
  if (
    providerName !== "bedrock" &&
    providerName !== "openai" &&
    providerName !== "ollama"
  ) {
    throw new Error(
      `Unknown EMBEDDING_PROVIDER: "${providerName}". Valid options: bedrock | openai | ollama`
    );
  }

  const explicitModel = process.env.EMBEDDING_MODEL;
  const dimsRaw = process.env.EMBEDDING_DIM
    ? parseInt(process.env.EMBEDDING_DIM, 10)
    : undefined;
  if (dimsRaw !== undefined && (isNaN(dimsRaw) || dimsRaw <= 0)) {
    throw new Error(
      `EMBEDDING_DIM must be a positive integer, got: "${process.env.EMBEDDING_DIM}"`
    );
  }

  // Provider-specific defaults match the constants the old embed.ts shipped.
  let model: string;
  let dimensions: number;
  switch (providerName) {
    case "bedrock":
      model = explicitModel ?? "amazon.nova-2-multimodal-embeddings-v1:0";
      dimensions = dimsRaw ?? 1024;
      break;
    case "openai":
      model = explicitModel ?? "text-embedding-3-small";
      dimensions = dimsRaw ?? 1536;
      break;
    case "ollama":
      model = explicitModel ?? "nomic-embed-text";
      dimensions = dimsRaw ?? 768;
      break;
  }

  const maxCalls = parseInt(process.env.EMBEDDING_RATE_LIMIT ?? "30", 10);
  const windowSec = parseInt(process.env.EMBEDDING_RATE_WINDOW ?? "60", 10);
  if (isNaN(maxCalls) || maxCalls <= 0) {
    throw new Error(
      `EMBEDDING_RATE_LIMIT must be a positive integer, got: "${process.env.EMBEDDING_RATE_LIMIT}"`
    );
  }
  if (isNaN(windowSec) || windowSec <= 0) {
    throw new Error(
      `EMBEDDING_RATE_WINDOW must be a positive integer (seconds), got: "${process.env.EMBEDDING_RATE_WINDOW}"`
    );
  }

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  if (providerName === "ollama" && !/^https?:\/\//i.test(ollamaBaseUrl)) {
    throw new Error(
      `OLLAMA_BASE_URL must start with http:// or https://, got: "${ollamaBaseUrl}"`
    );
  }

  return {
    provider: providerName,
    model,
    dimensions,
    openaiApiKey: process.env.OPENAI_API_KEY,
    awsRegion: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    ollamaBaseUrl,
    rateLimit: { maxCalls, windowMs: windowSec * 1000 },
  };
}

/**
 * Read agent-model configuration from FOUNDERSOS_AGENT_* env vars.
 *
 * Returns undefined when FOUNDERSOS_AGENT_PROVIDER is unset: that absence
 * is the signal that no model is provisioned, which is how the runner
 * knows full run is unavailable (and falls back to refusing, like today).
 * Only called from buildAutonomousContext — interactive sessions never
 * need a model.
 *
 * Defaults when a provider IS set:
 *   model      = provider-specific (claude-sonnet-4-6 / gpt-4.1)
 *   maxTokens  = 4096
 *   keys       = ANTHROPIC_API_KEY / OPENAI_API_KEY (the latter shared
 *                with the embedding layer)
 */
export function readAgentModelConfigFromEnv(): AgentModelConfig | undefined {
  const raw = process.env.FOUNDERSOS_AGENT_PROVIDER;
  if (!raw) return undefined;

  const provider = raw.toLowerCase() as AgentModelConfig["provider"];
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `Unknown FOUNDERSOS_AGENT_PROVIDER: "${raw}". Valid options: anthropic | openai`
    );
  }

  const explicitModel = process.env.FOUNDERSOS_AGENT_MODEL;
  const model =
    explicitModel ??
    (provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4.1");

  const maxTokensRaw = process.env.FOUNDERSOS_AGENT_MAX_TOKENS;
  const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : 4096;
  if (isNaN(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `FOUNDERSOS_AGENT_MAX_TOKENS must be a positive integer, got: "${maxTokensRaw}"`
    );
  }

  return {
    provider,
    model,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    maxTokens,
  };
}

/**
 * Read the launch principal from FOUNDERSOS_PRINCIPAL.
 *
 * Default (unset) is "interactive": a human-present stdio MCP session.
 * Set "autonomous" when a scheduled, unattended runtime (the Option B
 * Agent SDK runner) starts the MCP server, so the server stamps an
 * autonomous actor and the hard gate arms: registerGovernanceTools serves
 * the reduced map (no approve_action / set_policy / pause_agents) and
 * preview_action floors every hold-tier action to staged_for_deferred_approval.
 *
 * Pure and exported so it can be tested without constructing a context.
 */
export function readPrincipalFromEnv(): "interactive" | "autonomous" {
  const raw = process.env.FOUNDERSOS_PRINCIPAL;
  if (!raw) return "interactive";
  const v = raw.toLowerCase();
  if (v !== "interactive" && v !== "autonomous") {
    throw new Error(
      `Unknown FOUNDERSOS_PRINCIPAL: "${raw}". Valid options: interactive | autonomous`
    );
  }
  return v;
}

/**
 * Build the self-hosted ToolContext from env vars. Cached as a
 * singleton because identity is fixed for the process lifetime
 * under stdio MCP. The first call constructs the Supabase service
 * client; later calls reuse the same context object.
 *
 * The principal is interactive by default. When FOUNDERSOS_PRINCIPAL is
 * "autonomous" (set by an unattended runtime), the actor is autonomous and
 * identityMode is background, which is what arms the hard gate outside the
 * in-process runner. The autonomous MCP server does NOT drive a model, so
 * no agentModel is read here (the runtime owns the loop).
 *
 * Throws (via createServiceClient) if SUPABASE_URL / SUPABASE_SECRET_KEY
 * are missing. Throws (via getCompanyId / getUserId) if the identity
 * env vars contain unsafe characters, or on an invalid FOUNDERSOS_PRINCIPAL.
 */
export function buildContext(): ToolContext {
  if (cached) return cached;

  const client = createServiceClient();
  const autonomous = readPrincipalFromEnv() === "autonomous";

  cached = {
    db: client,
    admin: client, // self-hosted: same client; service role bypasses RLS anyway
    companyId: getCompanyId(),
    userId: getUserId(),
    identityMode: autonomous ? "background" : "env",
    isSoloMode: isSoloMode(),
    // Interactive by default. When a scheduled runtime launches the server
    // with FOUNDERSOS_PRINCIPAL=autonomous, the actor is autonomous and the
    // hard gate refuses/stages hold-tier clearances. A per-process runId
    // (overridable via FOUNDERSOS_RUN_ID) attributes the run in the audit log.
    actor: autonomous
      ? { kind: "autonomous", runId: process.env.FOUNDERSOS_RUN_ID ?? randomUUID() }
      : { kind: "interactive", userId: getUserId() },
    embedding: readEmbeddingConfigFromEnv(),
  };

  return cached;
}

/**
 * Build a ToolContext for the unattended autonomous runner
 * (`founders-os-tick run`). Same env-driven identity and clients as
 * buildContext, but:
 *   - actor is { kind: "autonomous" }, which the hard gate keys off so a
 *     hold-tier action is staged for deferred approval and never executed.
 *   - identityMode is "background" (a server-internal job, no end user).
 *   - NOT cached: the runner is its own short-lived process, and we never
 *     want the autonomous actor to leak into a cached interactive context.
 *
 * Throws (via createServiceClient / getCompanyId / getUserId) on the same
 * misconfiguration buildContext does.
 */
export function buildAutonomousContext(runId: string): ToolContext {
  const client = createServiceClient();
  return {
    db: client,
    admin: client,
    companyId: getCompanyId(),
    userId: getUserId(),
    identityMode: "background",
    isSoloMode: isSoloMode(),
    actor: { kind: "autonomous", runId },
    embedding: readEmbeddingConfigFromEnv(),
    // Present only for the autonomous principal. undefined => full run
    // is unavailable; the runner refuses rather than executes.
    agentModel: readAgentModelConfigFromEnv(),
  };
}

/**
 * Test-only: reset the cached context so a test can install a
 * fake ToolContext without leaking state across files. Not
 * exported from the package barrel; tests reach in directly.
 */
export function _resetContextForTests(): void {
  cached = null;
}
