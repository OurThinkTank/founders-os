// ============================================================
// Founders OS — Agent SDK runner adapter (T2.1)
// ============================================================
// The deployment-side half of the headless runner. The pure logic lives
// in core (agent/runner.ts); this file holds only what touches the
// process and the Claude Agent SDK:
//
//   * selectRunner    — which runner `tick run` dispatches to (pure).
//   * collectServerEnv / foundersOsLaunch / loadRunnerConnectors — build
//     the MCP launch config from this process's env.
//   * defaultRunQuery — wraps the Agent SDK query(), adapting its streamed
//     messages and canUseTool onto core's neutral types.
//
// The SDK is imported dynamically through a non-literal specifier so this
// module type-checks and the sandbox runs without the SDK installed; the
// real dependency loads at runtime on a provisioned host.
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type {
  RunnerQuery,
  RunnerMessage,
  RunnerMcpServers,
  RunAgentTickOptions,
  ConnectorPolicy,
} from "@ourthinktank/founders-os-core";

// ── Runner selection (pure) ────────────────────────────────

export type RunnerChoice = "agent-sdk" | "inprocess" | "hold-only" | "refuse";

/**
 * Decide which runner `founders-os-tick run` uses.
 *   - A full run is requested by --execute or FOUNDERSOS_TICK_RUN_MODE=full.
 *     It dispatches to the Agent SDK runner by default; FOUNDERSOS_TICK_RUNNER
 *     =inprocess selects the frozen Phase 2b in-process loop (the
 *     runtime-independent / OpenAI-capable fallback).
 *   - Otherwise --hold-only stages everything; bare `run` is refused.
 */
export function selectRunner(opts: {
  execute: boolean;
  holdOnly: boolean;
  runMode?: string;
  runner?: string;
}): RunnerChoice {
  const fullRequested = opts.execute || opts.runMode === "full";
  if (fullRequested) {
    return opts.runner === "inprocess" ? "inprocess" : "agent-sdk";
  }
  if (opts.holdOnly) return "hold-only";
  return "refuse";
}

// ── MCP launch config from env ─────────────────────────────

/** Copy this process's env (string entries) to hand to the spawned
 * founders-os server, so it inherits Supabase + identity + embedding
 * config. The runner forces the autonomous principal on top. */
export function collectServerEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** How to launch the founders-os stdio MCP server. Defaults to running the
 * sibling server bin with the current node (exact same installed version);
 * overridable for unusual layouts. */
export function foundersOsLaunch(): { command: string; args: string[] } {
  const override = process.env.FOUNDERSOS_MCP_COMMAND;
  if (override) {
    const args = process.env.FOUNDERSOS_MCP_ARGS
      ? (JSON.parse(process.env.FOUNDERSOS_MCP_ARGS) as string[])
      : [];
    return { command: override, args };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return { command: process.execPath, args: [resolve(here, "index.js")] };
}

/** Load the per-connector auto-dispatch policy from FOUNDERSOS_CONNECTOR_POLICY
 * (a JSON object keyed by connector, each with `actions` and optional
 * `scopeField`/`scopes`). Unset => {} => every connector is denied at the
 * hook, so the runner stays stage-only until a connector is explicitly
 * enabled. This is separate from the credential: the token lives in the
 * connectors MCP config (FOUNDERSOS_RUNNER_CONNECTORS), never here. */
export function loadConnectorPolicy(): ConnectorPolicy {
  const raw = process.env.FOUNDERSOS_CONNECTOR_POLICY;
  if (!raw) return {};
  return JSON.parse(raw) as ConnectorPolicy;
}

/** Load connector MCP servers from FOUNDERSOS_RUNNER_CONNECTORS (a JSON file
 * that is either an mcpServers map or { mcpServers: {...} }). None => the
 * runner is stage-only: it can prepare external actions but never send. */
export function loadRunnerConnectors(): RunnerMcpServers {
  const path = process.env.FOUNDERSOS_RUNNER_CONNECTORS;
  if (!path) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const maybe = parsed.mcpServers;
  if (maybe && typeof maybe === "object") return maybe as RunnerMcpServers;
  return parsed as RunnerMcpServers;
}

// ── Agent SDK boundary ─────────────────────────────────────

// Non-literal specifier so tsc does not resolve it and the sandbox needs no
// install. The dependency is declared in package.json and loads at runtime.
const SDK_PKG: string = "@anthropic-ai/claude-agent-sdk";

/**
 * Drive one Agent SDK session and adapt its stream to core's neutral
 * RunnerMessages. canUseTool is bridged so core owns the decision and the
 * SDK only enforces it. Tool_result blocks can arrive on user or assistant
 * messages, so both are scanned.
 */
export const defaultRunQuery: RunnerQuery = async function* (
  opts: RunAgentTickOptions
): AsyncIterable<RunnerMessage> {
  // The SDK is an OPTIONAL peer dependency (the runner is opt-in), so import
  // it lazily and explain how to add it if it is missing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    sdk = await import(SDK_PKG);
  } catch {
    throw new Error(
      "The Agent SDK runner needs @anthropic-ai/claude-agent-sdk (an optional dependency). " +
        "Install it to enable `run --execute`: npm install @anthropic-ai/claude-agent-sdk. " +
        "Or set FOUNDERSOS_TICK_RUNNER=inprocess for the fallback runner."
    );
  }
  const stream = sdk.query({
    prompt: opts.prompt,
    options: {
      mcpServers: opts.mcpServers,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
      maxTurns: opts.maxTurns ?? 40,
      ...(opts.model ? { model: opts.model } : {}),
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        const d = await opts.canUseTool(toolName, input);
        return d.behavior === "allow"
          ? { behavior: "allow", updatedInput: d.updatedInput ?? input }
          : { behavior: "deny", message: d.message };
      },
    },
  });

  for await (const message of stream as AsyncIterable<any>) {
    if ((message.type === "assistant" || message.type === "user") && message.message?.content) {
      for (const block of message.message.content) {
        if (block?.type === "tool_use") {
          yield { type: "tool_use", toolUse: { id: block.id, name: block.name, input: block.input ?? {} } };
        } else if (block?.type === "tool_result") {
          yield { type: "tool_result", toolUseId: block.tool_use_id, isError: block.is_error === true };
        }
      }
    } else if (message.type === "result") {
      yield { type: "result", subtype: message.subtype ?? "unknown" };
    }
  }
};
