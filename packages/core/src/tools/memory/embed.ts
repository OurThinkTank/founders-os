// ============================================================
// Founders OS — Pluggable Embedding Provider
// ============================================================
// Reads its configuration from ctx.embedding (an EmbeddingConfig
// object). Self-hosted builds the config from EMBEDDING_* env vars
// at startup via context.ts:readEmbeddingConfigFromEnv(); hosted
// resolves it per-tenant from a config store. The tool layer never
// touches env vars directly — see docs/multi-deployment-architecture.md.
//
// The vector dimension MUST match the vector() size in
// supabase/setup.sql. Set it once before running setup.
//
// ToolContext migration status (2026-05-28):
//   Fully contextual. The lint enforces no env-reading anywhere in
//   this file (HELPER_FILES list in tool-context-lint.test.ts).
// ============================================================

import type { EmbeddingConfig, ToolContext } from "../../types/context.js";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
}

// ── Provider: AWS Bedrock ──────────────────────────────────────────────────
// Default model: amazon.nova-2-multimodal-embeddings-v1:0 (1024 dims)
// Uses the standard AWS credential chain: env vars → ~/.aws → IAM role.

class BedrockProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private readonly model: string,
    dims: number,
    private readonly awsRegion: string
  ) {
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );

    const client = new BedrockRuntimeClient({ region: this.awsRegion });

    // Nova multimodal embedding request format
    const payload = JSON.stringify({
      taskType: "SINGLE_EMBEDDING",
      singleEmbeddingParams: {
        embeddingPurpose: "IMAGE_RETRIEVAL",
        embeddingDimension: this.dimensions,
        text: {
          value: text,
          truncationMode: "NONE",
        },
      },
    });

    const response = await client.send(
      new InvokeModelCommand({
        modelId: this.model,
        body: payload,
        contentType: "application/json",
        accept: "application/json",
      })
    );

    const body = JSON.parse(new TextDecoder().decode(response.body)) as {
      embeddings?: Array<{ embedding: number[] }>;
      embedding?: number[];
    };

    // Nova returns { embeddings: [{ embedding: [...] }] }; fall back to { embedding: [...] }
    const embedding = body?.embeddings?.[0]?.embedding ?? body?.embedding;

    if (!embedding || embedding.length !== this.dimensions) {
      throw new Error(
        `Bedrock embedding dimension mismatch: expected ${this.dimensions}, got ${embedding?.length ?? 0}`
      );
    }
    return embedding;
  }
}

// ── Provider: OpenAI ───────────────────────────────────────────────────────

class OpenAIProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private readonly model: string,
    dims: number,
    private readonly apiKey: string | undefined
  ) {
    this.dimensions = dims;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.apiKey)
      throw new Error(
        "OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai"
      );

    const { OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });

    const response = await client.embeddings.create({
      model: this.model,
      input: text,
      encoding_format: "float",
    });
    return response.data[0].embedding;
  }
}

// ── Provider: Ollama (local) ───────────────────────────────────────────────

class OllamaProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(
    private readonly model: string,
    dims: number,
    baseUrl: string
  ) {
    this.dimensions = dims;
    this.baseUrl = baseUrl;
    // Validate URL scheme to block non-HTTP(S) fetch targets
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new Error(`OLLAMA_BASE_URL must start with http:// or https://, got: "${this.baseUrl}"`);
    }
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });
    if (!response.ok)
      throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    const body = (await response.json()) as { embedding: number[] };
    return body.embedding;
  }
}

// ── Provider factory ───────────────────────────────────────────────────────
//
// Caches one provider instance per (provider, model, dimensions) tuple so
// the heavy clients (Bedrock SDK, OpenAI SDK) are not reconstructed on
// every embed() call. Under self-hosted there is one config for the
// lifetime of the process so the cache holds a single entry; under hosted
// the cache grows as different tenants make calls.

function configCacheKey(config: EmbeddingConfig): string {
  return `${config.provider}|${config.model}|${config.dimensions}`;
}

const providerCache = new Map<string, EmbeddingProvider>();

export function getEmbeddingProvider(
  config: EmbeddingConfig
): EmbeddingProvider {
  const key = configCacheKey(config);
  const cached = providerCache.get(key);
  if (cached) return cached;

  let provider: EmbeddingProvider;
  switch (config.provider) {
    case "bedrock":
      provider = new BedrockProvider(
        config.model,
        config.dimensions,
        config.awsRegion ?? "us-east-1"
      );
      break;
    case "openai":
      provider = new OpenAIProvider(
        config.model,
        config.dimensions,
        config.openaiApiKey
      );
      break;
    case "ollama":
      provider = new OllamaProvider(
        config.model,
        config.dimensions,
        config.ollamaBaseUrl ?? "http://localhost:11434"
      );
      break;
  }

  providerCache.set(key, provider);
  return provider;
}

// ── Token-bucket rate limiter ─────────────────────────────────
// Prevents runaway embedding costs from tight loops. Cached per
// rate-limit setting so different tenants (hosted) get isolated
// buckets; under self-hosted there is a single bucket for the
// process.

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillIntervalMs: number
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      // Full refill on each window - simple and predictable
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    }
  }

  acquire(): boolean {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  /** @internal - for tests */
  reset(): void {
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
  }
}

const bucketCache = new Map<string, TokenBucket>();

function bucketCacheKey(config: EmbeddingConfig): string {
  // Buckets are per-tenant in hosted; the rate-limit pair is the
  // tenant-distinguishing dimension we care about.
  return `${config.rateLimit.maxCalls}|${config.rateLimit.windowMs}`;
}

function getBucket(config: EmbeddingConfig): TokenBucket {
  const key = bucketCacheKey(config);
  const cached = bucketCache.get(key);
  if (cached) return cached;
  const bucket = new TokenBucket(
    config.rateLimit.maxCalls,
    config.rateLimit.windowMs
  );
  bucketCache.set(key, bucket);
  return bucket;
}

/**
 * Convenience wrapper used by all memory tools. Reads provider +
 * rate-limit configuration from ctx.embedding. Rate-limited.
 */
export async function embed(ctx: ToolContext, text: string): Promise<number[]> {
  const config = ctx.embedding;
  const bucket = getBucket(config);
  if (!bucket.acquire()) {
    const windowSec = Math.round(config.rateLimit.windowMs / 1000);
    throw new Error(
      `Embedding rate limit exceeded (${config.rateLimit.maxCalls} calls ` +
        `per ${windowSec}s). Wait and retry.`
    );
  }
  return getEmbeddingProvider(config).embed(text);
}

/**
 * Reset the cached provider singletons and rate limiters.
 * Used in tests to allow config changes to take effect between
 * test cases.
 * @internal
 */
export function _resetProviderForTesting(): void {
  providerCache.clear();
  for (const bucket of bucketCache.values()) bucket.reset();
  bucketCache.clear();
}
