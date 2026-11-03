// ============================================================
// Founders OS - Tool Annotations
// ============================================================
// Shared MCP tool annotation sets. Every tool sets all four
// hints explicitly. See "Annotations" in
// packages/mcp-server/TOOL_PATTERNS.md for which set a tool uses.
// ============================================================

export type ToolHints = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** Reads company data only. */
export const READ_ONLY: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Reads only, and fetches feed URLs over the network on a cache miss. */
export const READ_ONLY_NETWORK: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** Removes, purges, or takes away access. Soft deletes count. */
export const DESTRUCTIVE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

/** Changes existing rows in place without removing anything. */
export const EDIT: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Adds new rows; calling twice adds twice. */
export const ADDITIVE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Writes feed data and fetches feed URLs over the network. */
export const NETWORK_WRITE: ToolHints = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
