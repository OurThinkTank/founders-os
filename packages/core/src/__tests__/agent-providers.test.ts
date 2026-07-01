// ============================================================
// Founders OS — Agent provider implementations (Phase 2b.3)
// ============================================================
// Verifies AnthropicAgentModel and OpenAIAgentModel translate the neutral
// AgentMessage[]/AgentTool[] to and from each SDK's tool-use dialect, and
// that a turn that should call a tool round-trips into AgentTurn.toolCalls.
// A fake client is injected into each model, so there is no SDK call and no
// network. Also covers getAgentModel returning the right concrete provider.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  AnthropicAgentModel,
  OpenAIAgentModel,
  getAgentModel,
  _resetAgentModelForTesting,
  toAnthropicMessages,
  toOpenAIMessages,
  type AgentTool,
  type AgentMessage,
} from "../agent/model.js";
import type { AgentModelConfig } from "../types/context.js";

const TOOLS: AgentTool[] = [
  { name: "create_task", description: "Create a task.", inputSchema: { type: "object" } },
];

const anthropicCfg: AgentModelConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  anthropicApiKey: "sk-ant-test",
  maxTokens: 1024,
};
const openaiCfg: AgentModelConfig = {
  provider: "openai",
  model: "gpt-4.1",
  openaiApiKey: "sk-openai-test",
  maxTokens: 1024,
};

describe("AnthropicAgentModel.turn (injected client)", () => {
  it("sends translated tools + messages and parses a tool_use response", async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeClient = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          captured = body;
          return {
            content: [
              { type: "text", text: "on it" },
              { type: "tool_use", id: "tu_1", name: "create_task", input: { title: "Follow up" } },
            ],
            stop_reason: "tool_use",
          };
        },
      },
    };
    const model = new AnthropicAgentModel(anthropicCfg, fakeClient);
    const turn = await model.turn({
      system: "SYS",
      messages: [{ role: "user", content: "a watch fired" }],
      tools: TOOLS,
    });

    // Round-trips into AgentTurn.toolCalls.
    expect(turn.stop).toBe("tool_use");
    expect(turn.text).toBe("on it");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toEqual({ id: "tu_1", name: "create_task", input: { title: "Follow up" } });

    // Sent the Anthropic-shaped request.
    expect(captured!.model).toBe("claude-sonnet-4-6");
    expect(captured!.max_tokens).toBe(1024);
    expect(captured!.system).toBe("SYS");
    expect((captured!.tools as any[])[0].input_schema).toEqual({ type: "object" });
  });

  it("maps max_tokens stop_reason to 'limit' and end_turn to 'end'", async () => {
    const mk = (stop: string) =>
      new AnthropicAgentModel(anthropicCfg, {
        messages: { create: async () => ({ content: [{ type: "text", text: "x" }], stop_reason: stop }) },
      });
    expect((await mk("max_tokens").turn({ system: "", messages: [], tools: [] })).stop).toBe("limit");
    expect((await mk("end_turn").turn({ system: "", messages: [], tools: [] })).stop).toBe("end");
  });
});

describe("OpenAIAgentModel.turn (injected client)", () => {
  it("sends translated tools + messages and parses a tool_calls response", async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeClient = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            captured = body;
            return {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      { id: "call_1", function: { name: "create_task", arguments: '{"title":"Follow up"}' } },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            };
          },
        },
      },
    };
    const model = new OpenAIAgentModel(openaiCfg, fakeClient);
    const turn = await model.turn({
      system: "SYS",
      messages: [{ role: "user", content: "a watch fired" }],
      tools: TOOLS,
    });

    expect(turn.stop).toBe("tool_use");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toEqual({ id: "call_1", name: "create_task", input: { title: "Follow up" } });

    // system folded into messages; function tool shape sent.
    expect((captured!.messages as any[])[0]).toEqual({ role: "system", content: "SYS" });
    expect((captured!.tools as any[])[0].type).toBe("function");
    expect((captured!.tools as any[])[0].function.name).toBe("create_task");
  });

  it("tolerates malformed tool-call arguments without throwing", async () => {
    const model = new OpenAIAgentModel(openaiCfg, {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: { content: null, tool_calls: [{ id: "c", function: { name: "create_task", arguments: "not json" } }] },
                finish_reason: "tool_calls",
              },
            ],
          }),
        },
      },
    });
    const turn = await model.turn({ system: "", messages: [], tools: [] });
    expect(turn.toolCalls[0].input).toEqual({});
  });
});

describe("message translation round-trips a tool loop", () => {
  const convo: AgentMessage[] = [
    { role: "user", content: "fire" },
    { role: "assistant", content: "calling", toolCalls: [{ id: "x1", name: "create_task", input: { title: "t" } }] },
    { role: "tool_result", toolCallId: "x1", content: '{"ok":true}' },
  ];

  it("Anthropic: assistant tool_use block + tool_result rides in a user message", () => {
    const msgs = toAnthropicMessages(convo);
    expect(msgs[1].role).toBe("assistant");
    expect((msgs[1].content as any[]).some((b) => b.type === "tool_use" && b.id === "x1")).toBe(true);
    expect(msgs[2].role).toBe("user");
    expect((msgs[2].content as any[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "x1" });
  });

  it("OpenAI: assistant.tool_calls + a role:tool result keyed by id", () => {
    const msgs = toOpenAIMessages("SYS", convo);
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect((assistant.tool_calls as any[])[0].id).toBe("x1");
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("x1");
  });
});

describe("getAgentModel factory", () => {
  it("returns the concrete provider for each config", () => {
    _resetAgentModelForTesting();
    expect(getAgentModel(anthropicCfg)).toBeInstanceOf(AnthropicAgentModel);
    expect(getAgentModel(openaiCfg)).toBeInstanceOf(OpenAIAgentModel);
    // Cached per (provider, model).
    expect(getAgentModel(anthropicCfg)).toBe(getAgentModel(anthropicCfg));
    _resetAgentModelForTesting();
  });
});
