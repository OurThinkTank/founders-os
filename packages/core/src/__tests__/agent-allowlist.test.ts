// ============================================================
// Founders OS — Headless agent allowlist + callTool (Phase 2b.4)
// ============================================================
// Asserts Layer 1 at the tool layer:
//   * callTool dispatches contextual + legacy handlers and wraps a
//     thrown error as {error, isError:true} JSON rather than throwing.
//   * The allowlist resolves to exactly the 9 intended tools and the
//     dangerous tools (execute_action, remove_*/purge_*, set_policy,
//     pause_agents, approve_action) are ABSENT.
//   * buildAgentTools generates a JSON Schema for every allowlisted tool.
// ============================================================

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { callTool } from "../tools/register.js";
import type { ToolDefinition } from "../tools/register.js";
import {
  AGENT_TOOL_ALLOWLIST,
  buildAgentToolRegistry,
  buildAgentTools,
} from "../agent/allowlist.js";
import type { ToolContext } from "../types/context.js";

const fakeCtx = { companyId: "default", userId: "u" } as unknown as ToolContext;

describe("callTool — shared in-process dispatch", () => {
  it("passes ctx to a contextual handler and returns its JSON result", async () => {
    const tool: ToolDefinition = {
      title: "Echo",
      description: "echo",
      parameters: z.object({ n: z.number() }),
      handler: async (ctx: ToolContext, { n }: { n: number }) => ({ company: ctx.companyId, doubled: n * 2 }),
    };
    const out = await callTool(fakeCtx, tool, { n: 21 });
    expect(JSON.parse(out)).toEqual({ company: "default", doubled: 42 });
  });

  it("omits ctx for a legacy one-arg handler", async () => {
    const tool: ToolDefinition = {
      title: "Legacy",
      description: "legacy",
      parameters: z.object({ x: z.string() }),
      handler: async ({ x }: { x: string }) => ({ got: x }),
    };
    const out = await callTool(fakeCtx, tool, { x: "hi" });
    expect(JSON.parse(out)).toEqual({ got: "hi" });
  });

  it("catches a thrown error and returns it as {error, isError:true}", async () => {
    const tool: ToolDefinition = {
      title: "Boom",
      description: "boom",
      parameters: z.object({}),
      handler: async (_ctx: ToolContext) => {
        throw new Error("kaboom");
      },
    };
    const out = await callTool(fakeCtx, tool, {});
    expect(JSON.parse(out)).toEqual({ error: "kaboom", isError: true });
  });
});

describe("agent allowlist", () => {
  it("resolves to exactly the 9 intended tools", () => {
    const registry = buildAgentToolRegistry();
    expect(Object.keys(registry).sort()).toEqual(
      [
        "add_task_note",
        "create_task",
        "get_entity_card",
        "get_task",
        "list_tasks",
        "list_trigger_fires",
        "memory_recall",
        "notify_inbox",
        "preview_action",
      ].sort()
    );
  });

  it("does NOT expose any dangerous tool", () => {
    const forbidden = [
      "execute_action",
      "approve_action",
      "set_policy",
      "pause_agents",
      "remove_task",
      "remove_customer",
      "purge_item",
      "purge_items",
      "delete_trigger",
    ];
    for (const name of forbidden) {
      expect(AGENT_TOOL_ALLOWLIST as readonly string[]).not.toContain(name);
    }
    const registry = buildAgentToolRegistry();
    for (const name of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(registry, name)).toBe(false);
    }
  });

  it("generates a JSON Schema for all 9 allowlisted tools", () => {
    const tools = buildAgentTools();
    expect(tools).toHaveLength(AGENT_TOOL_ALLOWLIST.length);
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(0);
      // A valid object schema with no unresolved $ref (we inline refs).
      expect((t.inputSchema as { type?: string }).type).toBe("object");
      expect(JSON.stringify(t.inputSchema)).not.toContain("$ref");
    }
  });
});
