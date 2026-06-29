// ============================================================
// Tests for registerToolMap
// ============================================================
// registerToolMap is the central wrapper used by every tool
// domain. It:
//   1. Calls server.registerTool() for each entry in the ToolMap
//   2. Invokes the handler with the caller's params
//   3. Wraps the handler result in an MCP content envelope
//   4. Calls enrichDates() on the result (adds _display siblings)
//   5. Catches any thrown error → returns isError: true
//
// These tests use a fake MCP server (plain object with a
// registerTool method) so no SDK mocking is required. The
// handlers in the ToolMap are simple test functions.
// ============================================================

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../tools/register.js";
import { governanceTools } from "../tools/governance/index.js";
import { triggerTools } from "../tools/triggers/index.js";

// ── Fake MCP server ──────────────────────────────────────────
// Captures calls to registerTool() so we can inspect
// the name, config, and wrapped handler for each tool.

type WrappedHandler = (params: unknown) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeFakeServer() {
  const registered = new Map<string, { title: string; description: string; handler: WrappedHandler }>();
  return {
    registered,
    registerTool(
      name: string,
      config: { title: string; description: string; inputSchema: unknown },
      handler: WrappedHandler
    ) {
      registered.set(name, { title: config.title, description: config.description, handler });
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────

/** Call the MCP-wrapped handler for a named tool and return its output. */
async function callTool(
  server: ReturnType<typeof makeFakeServer>,
  name: string,
  params: unknown = {}
) {
  const entry = server.registered.get(name);
  if (!entry) throw new Error(`Tool "${name}" was not registered`);
  return entry.handler(params);
}

/** Parse the JSON text payload from an MCP response. */
function parsePayload(result: Awaited<ReturnType<typeof callTool>>) {
  return JSON.parse(result.content[0].text);
}

// ──────────────────────────────────────────────────────────────
// Registration behaviour
// ──────────────────────────────────────────────────────────────

describe("registerToolMap — tool registration", () => {
  it("TC-REG01: registers all tools in the ToolMap", () => {
    const server = makeFakeServer();
    const tools: ToolMap = {
      tool_alpha: {
        title: "Alpha",
        description: "First tool",
        parameters: z.object({}),
        handler: async () => ({}),
      },
      tool_beta: {
        title: "Beta",
        description: "Second tool",
        parameters: z.object({}),
        handler: async () => ({}),
      },
    };
    registerToolMap(server as never, tools);
    expect(server.registered.has("tool_alpha")).toBe(true);
    expect(server.registered.has("tool_beta")).toBe(true);
    expect(server.registered.size).toBe(2);
  });

  it("TC-REG02: registered tool carries the correct title and description", () => {
    const server = makeFakeServer();
    const tools: ToolMap = {
      my_tool: {
        title: "My Great Tool",
        description: "Does something useful",
        parameters: z.object({}),
        handler: async () => ({}),
      },
    };
    registerToolMap(server as never, tools);
    const entry = server.registered.get("my_tool")!;
    expect(entry.title).toBe("My Great Tool");
    expect(entry.description).toBe("Does something useful");
  });

  it("TC-REG03: empty ToolMap registers nothing and does not throw", () => {
    const server = makeFakeServer();
    expect(() => registerToolMap(server as never, {})).not.toThrow();
    expect(server.registered.size).toBe(0);
  });

  it("TC-REG04: a ToolMap with many tools registers all of them", () => {
    const server = makeFakeServer();
    const tools: ToolMap = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `tool_${i}`,
        {
          title: `Tool ${i}`,
          description: `Tool number ${i}`,
          parameters: z.object({}),
          handler: async () => ({ index: i }),
        },
      ])
    );
    registerToolMap(server as never, tools);
    expect(server.registered.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(server.registered.has(`tool_${i}`)).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// MCP content envelope: success path
// ──────────────────────────────────────────────────────────────

describe("registerToolMap — success path envelope", () => {
  it("TC-REG05: successful handler returns content array with one text item", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      greet: {
        title: "Greet",
        description: "Says hello",
        parameters: z.object({ name: z.string() }),
        handler: async ({ name }: { name: string }) => ({ greeting: `Hello ${name}` }),
      },
    });
    const result = await callTool(server, "greet", { name: "World" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("TC-REG06: handler result is JSON-serialised in the text field", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      data: {
        title: "Data",
        description: "Returns data",
        parameters: z.object({}),
        handler: async () => ({ count: 42, items: ["a", "b"] }),
      },
    });
    const result = await callTool(server, "data");
    const payload = parsePayload(result);
    expect(payload.count).toBe(42);
    expect(payload.items).toEqual(["a", "b"]);
  });

  it("TC-REG07: handler receives the params passed by the caller", async () => {
    const server = makeFakeServer();
    const captured: unknown[] = [];
    registerToolMap(server as never, {
      echo: {
        title: "Echo",
        description: "Echoes params",
        parameters: z.object({ value: z.string() }),
        handler: async (params) => {
          captured.push(params);
          return { ok: true };
        },
      },
    });
    await callTool(server, "echo", { value: "hello" });
    expect(captured).toHaveLength(1);
    expect((captured[0] as { value: string }).value).toBe("hello");
  });

  it("TC-REG08: isError is not set on a successful response", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      ok: {
        title: "OK",
        description: "Always succeeds",
        parameters: z.object({}),
        handler: async () => ({ success: true }),
      },
    });
    const result = await callTool(server, "ok");
    expect(result.isError).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────
// MCP content envelope: error path
// ──────────────────────────────────────────────────────────────

describe("registerToolMap — error path envelope", () => {
  it("TC-REG09: thrown Error is caught and returned with isError=true", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      broken: {
        title: "Broken",
        description: "Always throws",
        parameters: z.object({}),
        handler: async () => { throw new Error("database unavailable"); },
      },
    });
    const result = await callTool(server, "broken");
    expect(result.isError).toBe(true);
  });

  it("TC-REG10: error message from a thrown Error appears in the text payload", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      broken: {
        title: "Broken",
        description: "Always throws",
        parameters: z.object({}),
        handler: async () => { throw new Error("unique constraint violated"); },
      },
    });
    const result = await callTool(server, "broken");
    const payload = parsePayload(result);
    expect(payload.error).toBe("unique constraint violated");
  });

  it("TC-REG11: non-Error thrown values produce 'Unknown error' in the payload", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      weird: {
        title: "Weird",
        description: "Throws a non-Error",
        parameters: z.object({}),
        handler: async () => { throw "not an error object"; },
      },
    });
    const result = await callTool(server, "weird");
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe("Unknown error");
  });

  it("TC-REG12: error response still has content array with one text item", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      broken: {
        title: "Broken",
        description: "Always throws",
        parameters: z.object({}),
        handler: async () => { throw new Error("boom"); },
      },
    });
    const result = await callTool(server, "broken");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("TC-REG13: rejected promise is treated the same as a thrown error", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      async_fail: {
        title: "Async Fail",
        description: "Returns a rejected promise",
        parameters: z.object({}),
        handler: () => Promise.reject(new Error("async rejection")),
      },
    });
    const result = await callTool(server, "async_fail");
    expect(result.isError).toBe(true);
    expect(parsePayload(result).error).toBe("async rejection");
  });
});

// ──────────────────────────────────────────────────────────────
// enrichDates integration
// ──────────────────────────────────────────────────────────────

describe("registerToolMap — enrichDates integration", () => {
  it("TC-REG14: date-only strings in the response get a _display sibling", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      dated: {
        title: "Dated",
        description: "Returns a date",
        parameters: z.object({}),
        handler: async () => ({ due_date: "2026-04-30" }),
      },
    });
    const result = await callTool(server, "dated");
    const payload = parsePayload(result);
    expect(payload.due_date).toBe("2026-04-30");
    expect(payload.due_date_display).toBeDefined();
    expect(typeof payload.due_date_display).toBe("string");
    expect(payload.due_date_display).toContain("2026"); // formatted human date
  });

  it("TC-REG15: ISO datetime strings get a _display sibling with time", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      stamped: {
        title: "Stamped",
        description: "Returns a timestamp",
        parameters: z.object({}),
        handler: async () => ({ completed_at: "2026-04-24T14:30:00Z" }),
      },
    });
    const result = await callTool(server, "stamped");
    const payload = parsePayload(result);
    expect(payload.completed_at_display).toBeDefined();
    expect(payload.completed_at_display).toContain("2026");
  });

  it("TC-REG16: keys in SKIP_KEYS (id, user_id, etc.) are not enriched", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      with_id: {
        title: "With ID",
        description: "Returns ID-like fields",
        parameters: z.object({}),
        // IDs sometimes look like dates but must not be enriched (they're in SKIP_KEYS)
        handler: async () => ({
          id: "2026-04-24",         // SKIP_KEYS: no _display added
          user_id: "2026-04-24",    // SKIP_KEYS: no _display added
          due_date: "2026-04-24",   // not in SKIP_KEYS: _display is added
        }),
      },
    });
    const result = await callTool(server, "with_id");
    const payload = parsePayload(result);
    // id and user_id should NOT get display siblings
    expect(payload.id_display).toBeUndefined();
    expect(payload.user_id_display).toBeUndefined();
    // due_date SHOULD get a display sibling
    expect(payload.due_date_display).toBeDefined();
  });

  it("TC-REG17: nested objects also have dates enriched", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      nested: {
        title: "Nested",
        description: "Returns nested data",
        parameters: z.object({}),
        handler: async () => ({
          task: { due_date: "2026-05-01", title: "Ship it" },
        }),
      },
    });
    const result = await callTool(server, "nested");
    const payload = parsePayload(result);
    expect(payload.task.due_date_display).toBeDefined();
    expect(payload.task.title).toBe("Ship it"); // non-date fields untouched
  });

  it("TC-REG18: non-date strings are not enriched", async () => {
    const server = makeFakeServer();
    registerToolMap(server as never, {
      plain: {
        title: "Plain",
        description: "Returns plain text",
        parameters: z.object({}),
        handler: async () => ({ name: "Acme Corp", status: "active" }),
      },
    });
    const result = await callTool(server, "plain");
    const payload = parsePayload(result);
    expect(payload.name_display).toBeUndefined();
    expect(payload.status_display).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────
// Contextual dispatch (ToolContext routing)
// ──────────────────────────────────────────────────────────────
//
// The dispatcher uses handler.length to distinguish legacy and
// contextual handlers. A no-params contextual tool MUST still be
// authored with two declared parameters (e.g. `(ctx, _params)`)
// so its .length is 2; otherwise it gets misrouted as a legacy
// handler and `ctx` ends up bound to the input params object at
// runtime, producing `undefined.from(...)` errors.
//
// These tests pin that contract.

describe("registerToolMap — contextual handler dispatch", () => {
  const mockCtx = { sentinel: "ctx" } as unknown as Parameters<
    typeof registerToolMap
  >[2];

  it("TC-REG19: two-arg handler receives ctx as the first argument", async () => {
    const server = makeFakeServer();
    const captured: { ctx?: unknown; params?: unknown } = {};
    registerToolMap(
      server as never,
      {
        ctx_tool: {
          title: "Ctx Tool",
          description: "Receives ctx",
          parameters: z.object({ value: z.string() }),
          handler: async (ctx, params) => {
            captured.ctx = ctx;
            captured.params = params;
            return { ok: true };
          },
        },
      },
      mockCtx
    );
    await callTool(server, "ctx_tool", { value: "x" });
    expect(captured.ctx).toBe(mockCtx);
    expect((captured.params as { value: string }).value).toBe("x");
  });

  it("TC-REG20: registering a two-arg handler without ctx throws at registration", () => {
    const server = makeFakeServer();
    expect(() =>
      registerToolMap(server as never, {
        ctx_tool: {
          title: "Ctx Tool",
          description: "Needs ctx",
          parameters: z.object({}),
          handler: async (_ctx, _params) => ({}),
        },
      })
    ).toThrow(/expects a ToolContext but none was/);
  });

  it("TC-REG21: a no-params contextual handler MUST declare two arguments to be routed correctly", async () => {
    // Regression for the v0.13.5 list_members/refresh_feeds bug: a
    // handler authored as `async (ctx) => {}` has length 1 and gets
    // dispatched as legacy, so ctx is bound to the params object
    // (typically `{}`), and the first ctx.<anything> access blows up.
    const server = makeFakeServer();
    const captured: { firstArg?: unknown } = {};
    registerToolMap(
      server as never,
      {
        single_arg: {
          title: "Single Arg",
          description: "Wrongly authored single-arg contextual handler",
          parameters: z.object({}),
          // Intentionally declared with only one parameter.
          handler: async (firstArg) => {
            captured.firstArg = firstArg;
            return { ok: true };
          },
        },
      },
      mockCtx
    );
    await callTool(server, "single_arg", {});
    // The dispatcher treats this as legacy: firstArg is the params
    // object, NOT the context. This documents the failure mode so
    // future authors learn to use `(ctx, _params)` for no-args tools.
    expect(captured.firstArg).not.toBe(mockCtx);
  });

  // These domains are entirely contextual (no legacy handlers), so every
  // handler MUST declare two arguments to route correctly. This pins the
  // real exported maps so a no-args tool authored as `(ctx) =>` (which
  // crashed get_policy / list_pending_approvals with `undefined.from`)
  // fails CI instead of only surfacing at runtime in a demo.
  it("TC-REG22: every governance tool handler declares two arguments", () => {
    for (const [name, tool] of Object.entries(governanceTools)) {
      expect(tool.handler.length, `governance tool "${name}" must be (ctx, params)`).toBeGreaterThanOrEqual(2);
    }
  });

  it("TC-REG23: every trigger tool handler declares two arguments", () => {
    for (const [name, tool] of Object.entries(triggerTools)) {
      expect(tool.handler.length, `trigger tool "${name}" must be (ctx, params)`).toBeGreaterThanOrEqual(2);
    }
  });
});
