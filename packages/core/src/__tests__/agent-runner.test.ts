// ============================================================
// Founders OS — Headless Agent SDK runner core (T2.1)
// ============================================================
// Exercises the provider-neutral runner pieces with no Agent SDK: the
// MCP config builder, the tool surface, the permission callback, the
// accounting, and the orchestrator with an injected fake query.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  buildRunnerMcpServers,
  foundersOsAllowedToolNames,
  runnerAllowedTools,
  isConnectorTool,
  makeRunnerCanUseTool,
  summarizeRunnerMessages,
  runAgentTick,
  RUNNER_FOUNDERS_OS_TOOLS,
  type RunnerMessage,
  type RunnerMcpStdioServer,
  type RunAgentTickOptions,
} from "../agent/runner.js";
import { AGENT_TOOL_ALLOWLIST } from "../agent/allowlist.js";

const fos = (t: string) => `mcp__founders-os__${t}`;

describe("buildRunnerMcpServers", () => {
  const base = {
    runId: "run-7",
    serverCommand: "npx",
    serverArgs: ["-y", "@ourthinktank/founders-os@latest"],
    serverEnv: { SUPABASE_URL: "u", SUPABASE_SECRET_KEY: "k", FOUNDERS_OS_COMPANY_ID: "acme" },
  };

  it("always launches founders-os as the autonomous principal with the run id", () => {
    const cfg = buildRunnerMcpServers(base);
    const f = cfg["founders-os"] as RunnerMcpStdioServer;
    expect(f.command).toBe("npx");
    expect(f.env?.FOUNDERSOS_PRINCIPAL).toBe("autonomous");
    expect(f.env?.FOUNDERSOS_RUN_ID).toBe("run-7");
    expect(f.env?.SUPABASE_URL).toBe("u");
  });

  it("forces the autonomous principal even if the inherited env tried to set interactive", () => {
    const cfg = buildRunnerMcpServers({
      ...base,
      serverEnv: { ...base.serverEnv, FOUNDERSOS_PRINCIPAL: "interactive" },
    });
    const f = cfg["founders-os"] as RunnerMcpStdioServer;
    expect(f.env?.FOUNDERSOS_PRINCIPAL).toBe("autonomous");
  });

  it("merges connector servers alongside founders-os", () => {
    const cfg = buildRunnerMcpServers({
      ...base,
      connectors: { slack: { command: "slack-mcp", args: [], env: { SLACK_BOT_TOKEN: "xoxb" } } },
    });
    expect(Object.keys(cfg).sort()).toEqual(["founders-os", "slack"]);
  });
});

describe("tool surface", () => {
  it("permits the autonomous allowlist plus resolve_trigger_fire and execute_action", () => {
    expect(RUNNER_FOUNDERS_OS_TOOLS).toContain("resolve_trigger_fire");
    for (const t of AGENT_TOOL_ALLOWLIST) expect(RUNNER_FOUNDERS_OS_TOOLS).toContain(t);
  });

  it("adds execute_action to the SDK runner only, keeping the shared allowlist (Phase 2b) stage-only", () => {
    // The Agent SDK runner needs execute_action to mint a dispatch clearance;
    // the frozen Phase 2b runner (which reads AGENT_TOOL_ALLOWLIST) must not get it.
    expect(RUNNER_FOUNDERS_OS_TOOLS).toContain("execute_action");
    expect(AGENT_TOOL_ALLOWLIST as readonly string[]).not.toContain("execute_action");
  });

  it("allowedTools are founders-os patterns only (connectors gated by canUseTool, not auto-approved)", () => {
    const allowed = runnerAllowedTools();
    expect(allowed).toEqual(foundersOsAllowedToolNames());
    expect(allowed.every((t) => t.startsWith("mcp__founders-os__"))).toBe(true);
    expect(allowed.some((t) => t.includes("slack"))).toBe(false);
  });

  it("isConnectorTool distinguishes connector tools from founders-os tools", () => {
    expect(isConnectorTool("mcp__slack__send_message")).toBe(true);
    expect(isConnectorTool("mcp__founders-os__create_task")).toBe(false);
    expect(isConnectorTool("Read")).toBe(false);
  });
});

describe("makeRunnerCanUseTool", () => {
  it("allows a founders-os allowlisted tool", async () => {
    const can = makeRunnerCanUseTool({});
    expect((await can(fos("create_task"), {})).behavior).toBe("allow");
    expect((await can(fos("resolve_trigger_fire"), {})).behavior).toBe("allow");
  });

  it("denies a non-allowlisted founders-os tool (e.g. a destructive one)", async () => {
    const can = makeRunnerCanUseTool({});
    expect((await can(fos("remove_task"), {})).behavior).toBe("deny");
  });

  it("denies connector tools by default (stage-only): externals must go through preview_action", async () => {
    const can = makeRunnerCanUseTool({});
    const r = await can("mcp__slack__send_message", { text: "hi" });
    expect(r.behavior).toBe("deny");
  });

  it("routes connector tools to a provided connectorDecision (the T2.2 verify-clearance seam)", async () => {
    const seen: string[] = [];
    const can = makeRunnerCanUseTool({
      connectorDecision: async (name) => {
        seen.push(name);
        return { behavior: "allow" };
      },
    });
    const r = await can("mcp__slack__send_message", { text: "hi" });
    expect(r.behavior).toBe("allow");
    expect(seen).toEqual(["mcp__slack__send_message"]);
    // founders-os tools still bypass the connector decision
    expect((await can(fos("create_task"), {})).behavior).toBe("allow");
    expect(seen).toEqual(["mcp__slack__send_message"]);
  });
});

describe("summarizeRunnerMessages", () => {
  it("counts created, staged, resolved, and errors by tool name", () => {
    const msgs: RunnerMessage[] = [
      { type: "tool_use", toolUse: { id: "1", name: fos("list_trigger_fires"), input: {} } },
      { type: "tool_use", toolUse: { id: "2", name: fos("create_task"), input: {} } },
      { type: "tool_use", toolUse: { id: "3", name: fos("notify_inbox"), input: {} } },
      { type: "tool_use", toolUse: { id: "4", name: fos("preview_action"), input: {} } },
      { type: "tool_use", toolUse: { id: "5", name: fos("resolve_trigger_fire"), input: {} } },
      { type: "tool_result", toolUseId: "4", isError: false },
      { type: "tool_result", toolUseId: "9", isError: true },
      { type: "result", subtype: "success" },
    ];
    const s = summarizeRunnerMessages(msgs);
    expect(s).toEqual({ toolCalls: 5, created: 2, staged: 1, resolved: 1, errors: 1 });
  });
});

describe("runAgentTick", () => {
  it("drives the injected query to completion and returns the summary", async () => {
    const scripted: RunnerMessage[] = [
      { type: "tool_use", toolUse: { id: "1", name: fos("create_task"), input: {} } },
      { type: "tool_use", toolUse: { id: "2", name: fos("preview_action"), input: {} } },
      { type: "result", subtype: "success" },
    ];
    async function* fakeQuery(_opts: RunAgentTickOptions): AsyncIterable<RunnerMessage> {
      for (const m of scripted) yield m;
    }
    const opts: RunAgentTickOptions = {
      mcpServers: {},
      allowedTools: runnerAllowedTools(),
      systemPrompt: "x",
      prompt: "y",
      canUseTool: makeRunnerCanUseTool({}),
    };
    const summary = await runAgentTick(opts, fakeQuery);
    expect(summary.created).toBe(1);
    expect(summary.staged).toBe(1);
    expect(summary.toolCalls).toBe(2);
  });
});
