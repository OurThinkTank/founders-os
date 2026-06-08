// ============================================================
// Founders OS - ToolContext
// ============================================================
// Every tool handler eventually accepts a ToolContext instead of
// reading env vars and constructing Supabase clients inline. The
// context abstraction lets the same tool logic run under two very
// different deployment models:
//
//   * Self-hosted (today): ctx is built once at process startup
//     from env vars; db and admin are the same service-role client.
//   * Hosted (future): ctx is built per request from a Supabase
//     Auth JWT; db is a user-scoped client (RLS applies), admin is
//     a separate service-role client used only for privileged ops.
//
// Tools never need to know which world they are in. See
// docs/multi-deployment-architecture.md for the full design.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Identity source for the current request / process.
 *
 *   - 'env'        : self-hosted; identity from FOUNDERS_OS_* env vars.
 *   - 'jwt'        : hosted; identity from a validated Supabase Auth JWT.
 *   - 'background': server-internal job; no end user in the loop.
 */
export type IdentityMode = "env" | "jwt" | "background";

/**
 * Embedding provider configuration. Self-hosted builds this from
 * EMBEDDING_* env vars at startup; hosted builds it per-tenant
 * from a config store. See docs/multi-deployment-architecture.md.
 *
 * Provider-specific fields are optional; only the ones for the
 * active provider need to be set:
 *   - bedrock: uses standard AWS credential chain + awsRegion
 *   - openai:  requires openaiApiKey
 *   - ollama:  requires ollamaBaseUrl (defaults to http://localhost:11434)
 */
export type EmbeddingConfig = {
  provider: "bedrock" | "openai" | "ollama";
  model: string;
  dimensions: number;
  openaiApiKey?: string;
  awsRegion?: string;
  ollamaBaseUrl?: string;
  /** Token-bucket settings to bound runaway embedding costs. */
  rateLimit: {
    maxCalls: number;
    windowMs: number;
  };
};

/**
 * Per-tool execution context.
 *
 * `db` is the primary client used for every read and write that
 * should respect tenant boundaries. Under self-hosted this is the
 * service role client (which bypasses RLS, so the .eq("company_id",
 * ctx.companyId) filter that every tool already adds IS the
 * boundary). Under hosted this is a user-scoped client and RLS
 * provides the database-level fence; the explicit filter becomes
 * defense in depth.
 *
 * `admin` is a service-role client. Use it ONLY for operations
 * that legitimately need to bypass RLS even under hosted mode:
 * audit-log writes, background jobs, migrations, cross-tenant
 * admin operations. Any handler that calls ctx.admin must include
 * an inline comment explaining why bypass is needed. A lint check
 * enforces this convention as more tools migrate.
 */
export type ToolContext = {
  db: SupabaseClient;
  admin: SupabaseClient;
  companyId: string;
  userId: string;
  identityMode: IdentityMode;
  /**
   * True when no real identity has been configured: both FOUNDERS_OS_USER_ID
   * and FOUNDERS_OS_COMPANY_ID resolve to their sample placeholders
   * (foundersuser1 / myawesomecompany; see utils/identity.ts). Used by financial
   * access checks and members tools to skip multi-user permission logic
   * for single-user self-hosted installs. Under hosted (identityMode='jwt')
   * this is always false because the JWT carries a real identity.
   */
  isSoloMode: boolean;
  /**
   * Embedding configuration for memory + similarity-search tools.
   * Self-hosted reads this once at startup from EMBEDDING_* env vars;
   * hosted resolves it per-tenant from a config store. See
   * docs/multi-deployment-architecture.md.
   */
  embedding: EmbeddingConfig;
};
