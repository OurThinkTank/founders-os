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

import { createServiceClient } from "./supabase.js";
import { getCompanyId, getUserId, isSoloMode } from "./utils/identity.js";
import type { EmbeddingConfig, ToolContext } from "./types/context.js";

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
 * Build the self-hosted ToolContext from env vars. Cached as a
 * singleton because identity is fixed for the process lifetime
 * under stdio MCP. The first call constructs the Supabase service
 * client; later calls reuse the same context object.
 *
 * Throws (via createServiceClient) if SUPABASE_URL / SUPABASE_SECRET_KEY
 * are missing. Throws (via getCompanyId / getUserId) if the identity
 * env vars contain unsafe characters.
 */
export function buildContext(): ToolContext {
  if (cached) return cached;

  const client = createServiceClient();

  cached = {
    db: client,
    admin: client, // self-hosted: same client; service role bypasses RLS anyway
    companyId: getCompanyId(),
    userId: getUserId(),
    identityMode: "env",
    isSoloMode: isSoloMode(),
    embedding: readEmbeddingConfigFromEnv(),
  };

  return cached;
}

/**
 * Test-only: reset the cached context so a test can install a
 * fake ToolContext without leaking state across files. Not
 * exported from the package barrel; tests reach in directly.
 */
export function _resetContextForTests(): void {
  cached = null;
}
