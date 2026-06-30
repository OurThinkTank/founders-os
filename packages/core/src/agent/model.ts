// ============================================================
// Founders OS — Pluggable Agent Model (provider-abstracted)
// ============================================================
// The headless runner (`founders-os-tick run --execute`, Phase 2b)
// drives one model turn at a time over a neutral, provider-agnostic
// message/tool shape. This file is the seam, mirroring the embedding-
// provider layer in tools/memory/embed.ts:
//
//   * AgentModel is the interface the runner loop talks to. It never
//     sees a wire format; each provider translates the neutral
//     AgentMessage[]/AgentTool[] to and from its own tool-use dialect.
//   * getAgentModel(config) is the cached factory, shaped like
//     getEmbeddingProvider. The two real providers (Anthropic, OpenAI)
//     land in Phase 2b.3; until then the factory throws a clear error
//     for them, and MockAgentModel covers the tests.
//   * AgentModelConfig lives on ToolContext (ctx.agentModel) and is
//     read once from env by readAgentModelConfigFromEnv() in
//     context.ts — built ONLY for the autonomous principal. Its
//     absence is how the runner knows full run is unavailable.
//
// The tool layer never reads env vars directly — see
// docs/multi-deployment-architecture.md.
// ============================================================

import type { AgentModelConfig } from "../types/context.js";

// ── Neutral, provider-agnostic shapes ──────────────────────────────────────
// These are the only shapes the runner loop sees. Providers translate to and
// from their own tool-use dialects on the way in and out of turn().

/** A tool offered to the model, with JSON Schema parameters. */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema (from zod-to-json-schema in Phase 2b.4). */
  inputSchema: object;
}

/**
 * One message in the running conversation. A `tool_result` carries the
 * JSON-stringified output of a tool the model called on the previous turn,
 * keyed back to that call by toolCallId.
 */
export type AgentMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "tool_result"; toolCallId: string; content: string };

/** A single tool invocation the model decided to make this turn. */
export interface AgentToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The result of one assistant turn: optional prose, zero or more tool calls,
 * and why the model stopped. `stop` is "tool_use" when toolCalls is non-empty,
 * "end" when the model is done, "limit" when it hit a token ceiling.
 */
export interface AgentTurn {
  text?: string;
  toolCalls: AgentToolCall[];
  stop: "tool_use" | "end" | "limit";
}

/**
 * The provider-agnostic model interface. One call = one assistant turn:
 * system prompt + running messages + available tools in, assistant text
 * and/or tool calls out. The loop that strings turns together lives in the
 * runner (Phase 2b.5), not here.
 */
export interface AgentModel {
  readonly model: string;
  turn(input: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn>;
}

// ── Provider factory ────────────────────────────────────────────────────────
//
// Caches one provider instance per (provider, model) tuple so the heavy SDK
// clients are not reconstructed on every turn. Under self-hosted there is one
// config for the process lifetime so the cache holds a single entry.
//
// The Anthropic and OpenAI implementations are added in Phase 2b.3; this
// factory throws a clear, actionable error for them until then. MockAgentModel
// is NOT routed through here — tests construct it directly, exactly as the
// embedding layer leaves its fakes out of getEmbeddingProvider.

function configCacheKey(config: AgentModelConfig): string {
  return `${config.provider}|${config.model}`;
}

const providerCache = new Map<string, AgentModel>();

export function getAgentModel(config: AgentModelConfig): AgentModel {
  const key = configCacheKey(config);
  const cached = providerCache.get(key);
  if (cached) return cached;

  let provider: AgentModel;
  switch (config.provider) {
    case "anthropic":
    case "openai":
      // Real implementations land in Phase 2b.3 (AnthropicAgentModel /
      // OpenAIAgentModel). Until then, fail loud rather than silently
      // pretending full run is available.
      throw new Error(
        `Agent provider "${config.provider}" is not implemented yet ` +
          `(arrives in Phase 2b.3). Full run is unavailable.`
      );
    default: {
      // Exhaustiveness guard: a new provider in the union must be handled.
      const _never: never = config.provider;
      throw new Error(`Unknown agent provider: "${String(_never)}"`);
    }
  }

  providerCache.set(key, provider);
  return provider;
}

/**
 * Reset the cached provider singletons. Used in tests to allow config
 * changes to take effect between cases.
 * @internal
 */
export function _resetAgentModelForTesting(): void {
  providerCache.clear();
}

// ── MockAgentModel (tests) ──────────────────────────────────────────────────
//
// Returns a scripted sequence of AgentTurns, one per turn() call, so the
// runner loop can be exercised deterministically with no network. When the
// script is exhausted it returns a terminal { toolCalls: [], stop: "end" }
// turn, so a loop that keeps calling can never hang waiting for more.

export class MockAgentModel implements AgentModel {
  readonly model: string;
  private readonly script: AgentTurn[];
  private index = 0;

  /** Records every turn() input, for assertions about what the loop sent. */
  readonly calls: Array<{ system: string; messages: AgentMessage[]; tools: AgentTool[] }> = [];

  constructor(script: AgentTurn[], model = "mock-agent-1") {
    this.script = script;
    this.model = model;
  }

  async turn(input: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    this.calls.push(input);
    if (this.index < this.script.length) {
      return this.script[this.index++];
    }
    return { toolCalls: [], stop: "end" };
  }
}
