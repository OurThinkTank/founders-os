// ============================================================
// Tests for MCP tool annotations
// ============================================================
// Registers every domain the way src/index.ts does, against a
// fake MCP server that records the config passed to
// registerTool(), then checks the annotation hints on each tool.
// ============================================================

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  registerToolMap,
  registerCRMTools,
  registerTaskTools,
  registerTagTools,
  registerMemoryTools,
  registerFinancialTools,
  registerFinancialManagementTools,
  registerMemberTools,
  registerRSSTools,
  registerSurfaceTools,
  registerPlaybookTools,
  registerProjectTools,
  registerRestoreTools,
} from "../index.js";
import { READ_ONLY } from "../tools/annotations.js";
import type { ToolContext } from "../types/context.js";

const HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

type Annotations = Partial<Record<(typeof HINTS)[number], unknown>>;

function makeFakeServer() {
  const registered = new Map<string, Annotations | undefined>();
  return {
    registered,
    registerTool(name: string, config: { annotations?: Annotations }) {
      registered.set(name, config.annotations);
    },
  };
}

function registerAll() {
  const server = makeFakeServer();
  const ctx = {} as ToolContext;
  for (const register of [
    registerCRMTools,
    registerTaskTools,
    registerTagTools,
    registerMemoryTools,
    registerFinancialTools,
    registerFinancialManagementTools,
    registerMemberTools,
    registerRSSTools,
    registerSurfaceTools,
    registerPlaybookTools,
    registerProjectTools,
    registerRestoreTools,
  ]) {
    register(server as never, ctx);
  }
  return server.registered;
}

const tools = registerAll();

describe("tool annotations", () => {
  it("TC-ANN01: registerToolMap passes annotations through to registerTool", () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      sample: {
        title: "Sample",
        annotations: READ_ONLY,
        description: "Sample tool",
        parameters: z.object({}),
        handler: async () => ({}),
      },
    });
    expect(server.registered.get("sample")).toEqual(READ_ONLY);
  });

  it("TC-ANN02: every domain tool is registered", () => {
    expect(tools.size).toBe(97);
  });

  it("TC-ANN03: every tool sets all four hints as booleans", () => {
    for (const [name, annotations] of tools) {
      expect(annotations, name).toBeDefined();
      for (const hint of HINTS) {
        expect(typeof annotations![hint], `${name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("TC-ANN04: every remove_*, purge_* and memory_forget tool is destructive", () => {
    const names = [...tools.keys()].filter(
      (n) => /^(remove_|purge_)/.test(n) || n === "memory_forget"
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(tools.get(name)!.destructiveHint, name).toBe(true);
      expect(tools.get(name)!.readOnlyHint, name).toBe(false);
    }
  });

  it("TC-ANN05: every get_*, list_* and search_* tool is read-only", () => {
    const names = [...tools.keys()].filter((n) => /^(get_|list_|search_)/.test(n));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(tools.get(name)!.readOnlyHint, name).toBe(true);
      expect(tools.get(name)!.destructiveHint, name).toBe(false);
    }
  });

  it("TC-ANN06: no tool is both read-only and destructive", () => {
    for (const [name, annotations] of tools) {
      expect(
        annotations!.readOnlyHint === true && annotations!.destructiveHint === true,
        name
      ).toBe(false);
    }
  });

  it("TC-ANN07: access changes and transfers are destructive", () => {
    for (const name of ["set_financial_access", "set_member_owner", "transfer_between_accounts"]) {
      expect(tools.get(name)!.destructiveHint, name).toBe(true);
    }
    expect(tools.get("transfer_between_accounts")!.idempotentHint).toBe(false);
  });

  it("TC-ANN08: every add_* and create_* tool is not idempotent and not destructive", () => {
    const names = [...tools.keys()].filter((n) => /^(add_|create_)/.test(n));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(tools.get(name)!.idempotentHint, name).toBe(false);
      expect(tools.get(name)!.destructiveHint, name).toBe(false);
    }
  });

  it("TC-ANN09: feed tools that fetch over the network are open world", () => {
    for (const name of [
      "get_feed_items",
      "get_feed_briefing",
      "read_feed_item",
      "subscribe_feed",
      "refresh_feeds",
      "import_starter_feeds",
    ]) {
      expect(tools.get(name)!.openWorldHint, name).toBe(true);
    }
  });

  it("TC-ANN10: memory tools are not open world", () => {
    const names = [...tools.keys()].filter((n) => n.startsWith("memory_"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(tools.get(name)!.openWorldHint, name).toBe(false);
    }
  });
});
