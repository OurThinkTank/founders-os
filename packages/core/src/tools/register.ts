// ============================================================
// Founders OS — Shared Tool Registration Helper
// ============================================================
// registerToolMap() provides a single loop that:
//   1. Registers every tool in a ToolMap with the MCP server
//   2. Wraps every handler response in the MCP content envelope
//   3. Catches any thrown error and returns a structured
//      { error: message } response with isError: true
//
// This keeps all tool modules as pure data — they don't import
// McpServer and don't produce MCP envelopes directly. They
// just return plain objects (or throw Error on failure).
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { enrichDates } from "./dates.js";
import { isConflictResponse } from "./conflict.js";
import { RENDERING_CONTRACT_SHORT } from "../contract.js";
import type { ToolContext } from "../types/context.js";

/**
 * Tool handlers come in two shapes during the ToolContext migration:
 *
 *   Legacy: (params) => Promise<unknown>
 *           Reads env vars and constructs Supabase clients inline.
 *
 *   Contextual: (ctx, params) => Promise<unknown>
 *           Receives a ToolContext built once at startup; never calls
 *           createServiceClient / getCompanyId directly.
 *
 * registerToolMap detects which shape a handler uses via its declared
 * `.length` (the param count of the function). One-arg handlers run
 * the legacy path; two-arg handlers receive the ctx that was passed
 * into registerToolMap.
 *
 * Migration is incremental and one-tool-at-a-time. See
 * docs/multi-deployment-architecture.md and TOOL_PATTERNS.md for the
 * convention. The mcp-server-internal lint test in
 * __tests__/tool-context-lint.test.ts enforces that contextual
 * handlers do NOT also reach for env vars.
 */
export type LegacyHandler = (params: never) => Promise<unknown>;
export type ContextualHandler = (
  ctx: ToolContext,
  params: never
) => Promise<unknown>;

export type ToolDefinition = {
  title: string;
  description: string;
  parameters: z.ZodObject<z.ZodRawShape>;
  handler: LegacyHandler | ContextualHandler;
};

export type ToolMap = Record<string, ToolDefinition>;

/**
 * A handler is contextual (receives a ToolContext as its first arg) when
 * it declares two or more parameters. One-arg handlers are legacy and read
 * env vars inline. This is the single source of truth for the arity test
 * that both registerToolMap and callTool depend on.
 */
function isContextualHandler(handler: LegacyHandler | ContextualHandler): boolean {
  return handler.length >= 2;
}

/**
 * Invoke a tool handler, routing the ToolContext to contextual handlers
 * and omitting it for legacy ones. Throws if a contextual handler is
 * invoked without a ctx (the same loud failure registerToolMap guards at
 * registration time). The shared dispatch mechanics live here so the MCP
 * server and the headless agent (callTool) cannot drift apart.
 */
async function invokeHandler(
  tool: ToolDefinition,
  ctx: ToolContext | undefined,
  args: unknown
): Promise<unknown> {
  if (isContextualHandler(tool.handler)) {
    if (!ctx) {
      throw new Error(
        "invokeHandler: contextual tool invoked without a ToolContext."
      );
    }
    return (tool.handler as ContextualHandler)(ctx, args as never);
  }
  return (tool.handler as LegacyHandler)(args as never);
}

/**
 * Dispatch a single tool call in-process and return its result as a JSON
 * string. This is the seam the headless agent runner (Phase 2b.5) uses to
 * reach the exact same handlers the MCP server registers, without speaking
 * MCP to itself. Success returns the JSON-stringified handler result; a
 * thrown error is caught and returned as {"error": message, "isError": true}
 * so one failing tool call never throws out of the agent loop.
 *
 * Note: this intentionally does NOT run the MCP-server-only presentation
 * steps (date enrichment, the rendering-contract reminder). Those shape a
 * response for a human-facing client; the model consumes raw JSON.
 */
export async function callTool(
  ctx: ToolContext,
  tool: ToolDefinition,
  args: unknown
): Promise<string> {
  try {
    const result = await invokeHandler(tool, ctx, args);
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return JSON.stringify({ error: message, isError: true });
  }
}

/**
 * B2 - cold-start safety net. When a tool response carries a `render`
 * field, attach the short-form rendering contract reminder alongside
 * it. Plugin-less clients (and sessions that skip get_session_start)
 * pick up the contract from this field on the first render-bearing
 * response they see.
 *
 * Skipped when the response already carries a `rendering_contract`
 * field. get_session_start ships the full RENDERING_CONTRACT text;
 * we do not want to overwrite the full version with the short form.
 */
function attachRenderingContractReminder(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const obj = result as Record<string, unknown>;
  if (!("render" in obj)) return result;
  if ("rendering_contract" in obj) return result;
  return { ...obj, rendering_contract: RENDERING_CONTRACT_SHORT };
}

/**
 * Register a ToolMap with the MCP server.
 *
 * Accepts an optional `ctx` argument. Handlers declared with two
 * parameters (ContextualHandler) receive the ctx; handlers declared
 * with one (LegacyHandler) do not. Tools migrate from legacy to
 * contextual one at a time without coordination; both shapes can
 * coexist in the same map.
 *
 * If a contextual handler is present in the map but no ctx is
 * provided to registerToolMap, the call throws at registration time
 * rather than crashing later with `undefined.db.from(...)`. This
 * fails the build loudly the first time a domain accidentally
 * registers contextual tools without a ctx.
 */
export function registerToolMap(
  server: McpServer,
  tools: ToolMap,
  ctx?: ToolContext
): void {
  for (const [name, tool] of Object.entries(tools)) {
    const { title, description, parameters, handler } = tool;

    if (isContextualHandler(handler) && !ctx) {
      throw new Error(
        `registerToolMap: tool "${name}" expects a ToolContext but none was ` +
          `passed. Update the domain's register*Tools(server, ctx) call site.`
      );
    }

    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: parameters.shape,
      },
      async (params) => {
        try {
          const result = await invokeHandler(tool, ctx, params);
          const withReminder = attachRenderingContractReminder(result);

          // Conflict responses are questions, not data - skip date
          // enrichment and return as-is (NOT isError). They still
          // carry the rendering_contract reminder via the helper above.
          if (isConflictResponse(withReminder)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(withReminder, null, 2),
                },
              ],
            };
          }

          const enriched = enrichDates(withReminder);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(enriched, null, 2),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: message }),
              },
            ],
            isError: true,
          };
        }
      }
    );
  }
}
