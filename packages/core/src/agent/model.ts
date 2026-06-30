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
 * One message in the running conversation.
 *
 *   - user:        a plain text prompt.
 *   - assistant:   the model's prior turn. May carry text, tool calls, or
 *                  both — the runner pushes back the AgentTurn it received
 *                  so the provider can reconstruct the tool_use blocks that
 *                  the following tool_result(s) reference.
 *   - tool_result: the JSON-stringified output of a tool the model called,
 *                  keyed back to that call by toolCallId.
 */
export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: AgentToolCall[] }
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
      provider = new AnthropicAgentModel(config);
      break;
    case "openai":
      provider = new OpenAIAgentModel(config);
      break;
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

// ── Provider: Anthropic ─────────────────────────────────────────────────────
// Translates the neutral shapes to and from the Anthropic Messages tool-use
// dialect. The SDK is imported dynamically (mirroring embed.ts) so this module
// loads without the SDK present; tests inject a fake client instead.

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
}
interface AnthropicLikeClient {
  messages: { create(body: Record<string, unknown>): Promise<AnthropicResponse> };
}

/** Neutral AgentTool[] -> Anthropic tools. */
export function toAnthropicTools(tools: AgentTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/**
 * Neutral AgentMessage[] -> Anthropic messages. tool_result blocks must ride
 * in a user message; consecutive tool_results are merged into one user message
 * so they immediately follow the assistant tool_use turn they answer.
 */
export function toAnthropicMessages(
  messages: AgentMessage[]
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      out.push({ role: "assistant", content: blocks });
    } else {
      // tool_result -> user message with a tool_result block; merge onto the
      // previous user message when it is already carrying tool_result blocks.
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        (prev.content as unknown[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

/** Anthropic response -> neutral AgentTurn. */
export function parseAnthropicResponse(resp: AnthropicResponse): AgentTurn {
  const textParts: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  for (const block of resp.content ?? []) {
    if (block.type === "text" && block.text) textParts.push(block.text);
    else if (block.type === "tool_use" && block.id && block.name) {
      toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  const stop: AgentTurn["stop"] =
    resp.stop_reason === "tool_use"
      ? "tool_use"
      : resp.stop_reason === "max_tokens"
        ? "limit"
        : "end";
  return { text: textParts.join("") || undefined, toolCalls, stop };
}

export class AnthropicAgentModel implements AgentModel {
  readonly model: string;
  constructor(
    private readonly config: AgentModelConfig,
    private readonly client?: AnthropicLikeClient
  ) {
    this.model = config.model;
  }

  private async getClient(): Promise<AnthropicLikeClient> {
    if (this.client) return this.client;
    if (!this.config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required when FOUNDERSOS_AGENT_PROVIDER=anthropic");
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    return new Anthropic({ apiKey: this.config.anthropicApiKey }) as unknown as AnthropicLikeClient;
  }

  async turn(input: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    const client = await this.getClient();
    const resp = await client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: input.system,
      messages: toAnthropicMessages(input.messages),
      tools: toAnthropicTools(input.tools),
    });
    return parseAnthropicResponse(resp);
  }
}

// ── Provider: OpenAI ────────────────────────────────────────────────────────
// Translates to and from the OpenAI Chat Completions tool-use dialect. Reuses
// the existing `openai` dependency; the key is shared with the embedding layer.

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface OpenAIResponse {
  choices: Array<{
    message: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    finish_reason?: string | null;
  }>;
}
interface OpenAILikeClient {
  chat: { completions: { create(body: Record<string, unknown>): Promise<OpenAIResponse> } };
}

/** Neutral AgentTool[] -> OpenAI function tools. */
export function toOpenAITools(tools: AgentTool[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

/** system + neutral AgentMessage[] -> OpenAI chat messages. */
export function toOpenAIMessages(
  system: string,
  messages: AgentMessage[]
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.content ?? null };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

/** OpenAI response -> neutral AgentTurn. */
export function parseOpenAIResponse(resp: OpenAIResponse): AgentTurn {
  const choice = resp.choices?.[0];
  const msg = choice?.message ?? {};
  const toolCalls: AgentToolCall[] = (msg.tool_calls ?? []).map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = {};
    }
    return { id: tc.id, name: tc.function.name, input };
  });
  const stop: AgentTurn["stop"] =
    choice?.finish_reason === "tool_calls"
      ? "tool_use"
      : choice?.finish_reason === "length"
        ? "limit"
        : "end";
  return { text: msg.content ?? undefined, toolCalls, stop };
}

export class OpenAIAgentModel implements AgentModel {
  readonly model: string;
  constructor(
    private readonly config: AgentModelConfig,
    private readonly client?: OpenAILikeClient
  ) {
    this.model = config.model;
  }

  private async getClient(): Promise<OpenAILikeClient> {
    if (this.client) return this.client;
    if (!this.config.openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required when FOUNDERSOS_AGENT_PROVIDER=openai");
    }
    const { OpenAI } = await import("openai");
    return new OpenAI({ apiKey: this.config.openaiApiKey }) as unknown as OpenAILikeClient;
  }

  async turn(input: {
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    const client = await this.getClient();
    const resp = await client.chat.completions.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      tools: toOpenAITools(input.tools),
      tool_choice: "auto",
      messages: toOpenAIMessages(input.system, input.messages),
    });
    return parseOpenAIResponse(resp);
  }
}
