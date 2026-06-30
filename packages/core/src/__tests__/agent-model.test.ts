// ============================================================
// Founders OS — Agent model abstraction (Phase 2b.2)
// ============================================================
// Covers the seam the headless runner will drive in 2b.5:
//   * MockAgentModel replays a scripted AgentTurn sequence and records
//     what each turn() was sent, then terminates cleanly when exhausted.
//   * readAgentModelConfigFromEnv() returns undefined when no provider
//     is set (the "full run unavailable" signal) and a parsed config
//     when one is, with provider-specific model defaults.
//   * getAgentModel() throws a clear not-implemented-yet error for the
//     real providers (they arrive in 2b.3); the mock is not routed
//     through the factory.
// No network, no runner wiring.
// ============================================================

import { describe, it, expect, afterEach } from "vitest";
import {
  MockAgentModel,
  getAgentModel,
  _resetAgentModelForTesting,
  type AgentTool,
  type AgentTurn,
} from "../agent/model.js";
import { readAgentModelConfigFromEnv } from "../context.js";
import type { AgentModelConfig } from "../types/context.js";

const TOOLS: AgentTool[] = [
  { name: "create_task", description: "Create a task.", inputSchema: { type: "object" } },
];

describe("MockAgentModel", () => {
  it("replays the scripted turns in order, then terminates with stop:end", async () => {
    const script: AgentTurn[] = [
      { toolCalls: [{ id: "c1", name: "create_task", input: { title: "x" } }], stop: "tool_use" },
      { text: "done", toolCalls: [], stop: "end" },
    ];
    const model = new MockAgentModel(script);

    const t1 = await model.turn({ system: "S", messages: [{ role: "user", content: "fire" }], tools: TOOLS });
    expect(t1.stop).toBe("tool_use");
    expect(t1.toolCalls[0].name).toBe("create_task");

    const t2 = await model.turn({ system: "S", messages: [], tools: TOOLS });
    expect(t2.stop).toBe("end");
    expect(t2.toolCalls).toHaveLength(0);

    // Exhausted: keeps returning a terminal turn rather than hanging/throwing.
    const t3 = await model.turn({ system: "S", messages: [], tools: TOOLS });
    expect(t3.stop).toBe("end");
    expect(t3.toolCalls).toHaveLength(0);
  });

  it("records every turn() input for assertions", async () => {
    const model = new MockAgentModel([{ toolCalls: [], stop: "end" }]);
    await model.turn({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: TOOLS });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].system).toBe("SYS");
    expect(model.calls[0].tools).toEqual(TOOLS);
    expect(model.model).toBe("mock-agent-1");
  });
});

describe("readAgentModelConfigFromEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns undefined when no provider is configured (full run unavailable)", () => {
    delete process.env.FOUNDERSOS_AGENT_PROVIDER;
    expect(readAgentModelConfigFromEnv()).toBeUndefined();
  });

  it("defaults the model per provider and maxTokens to 4096", () => {
    process.env.FOUNDERSOS_AGENT_PROVIDER = "anthropic";
    delete process.env.FOUNDERSOS_AGENT_MODEL;
    delete process.env.FOUNDERSOS_AGENT_MAX_TOKENS;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const cfg = readAgentModelConfigFromEnv();
    expect(cfg).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      anthropicApiKey: "sk-ant-test",
      maxTokens: 4096,
    });
  });

  it("openai reuses OPENAI_API_KEY and defaults to gpt-4.1", () => {
    process.env.FOUNDERSOS_AGENT_PROVIDER = "openai";
    delete process.env.FOUNDERSOS_AGENT_MODEL;
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const cfg = readAgentModelConfigFromEnv();
    expect(cfg?.provider).toBe("openai");
    expect(cfg?.model).toBe("gpt-4.1");
    expect(cfg?.openaiApiKey).toBe("sk-openai-test");
  });

  it("honors explicit model + max tokens overrides", () => {
    process.env.FOUNDERSOS_AGENT_PROVIDER = "anthropic";
    process.env.FOUNDERSOS_AGENT_MODEL = "claude-opus-4-8";
    process.env.FOUNDERSOS_AGENT_MAX_TOKENS = "8192";
    const cfg = readAgentModelConfigFromEnv();
    expect(cfg?.model).toBe("claude-opus-4-8");
    expect(cfg?.maxTokens).toBe(8192);
  });

  it("throws on an unknown provider", () => {
    process.env.FOUNDERSOS_AGENT_PROVIDER = "gemini";
    expect(() => readAgentModelConfigFromEnv()).toThrow(/Unknown FOUNDERSOS_AGENT_PROVIDER/);
  });

  it("throws on a non-positive max tokens", () => {
    process.env.FOUNDERSOS_AGENT_PROVIDER = "anthropic";
    process.env.FOUNDERSOS_AGENT_MAX_TOKENS = "0";
    expect(() => readAgentModelConfigFromEnv()).toThrow(/positive integer/);
  });
});

describe("getAgentModel factory", () => {
  afterEach(() => _resetAgentModelForTesting());

  it("constructs a provider without throwing (key is only needed at turn time)", () => {
    const cfg: AgentModelConfig = { provider: "anthropic", model: "claude-sonnet-4-6", maxTokens: 4096 };
    const model = getAgentModel(cfg);
    expect(model.model).toBe("claude-sonnet-4-6");
    expect(typeof model.turn).toBe("function");
  });
});
