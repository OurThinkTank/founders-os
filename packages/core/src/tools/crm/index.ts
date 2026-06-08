import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { customerTools } from "./customers.js";
import { contactTools } from "./contacts.js";
import { interactionTools } from "./interactions.js";
import { dashboardTools } from "./dashboard.js";
import { registerToolMap, type ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";

// ============================================================
// CRM Tool Group — Registration
// ============================================================
// Registers all CRM tools via registerToolMap, which handles
// conflict detection, date enrichment, and error wrapping.
//
// `ctx` is the ToolContext built once at startup in src/index.ts.
// Contextual handlers receive it; legacy handlers ignore it.
// During the incremental migration, both shapes coexist here.
// ============================================================

// Aggregate raw map for transport-agnostic binding (barrel export). The
// registration function below is unchanged; this just names the combined map
// so a non-stdio wrapper can bind CRM tools without going through registerToolMap.
export const crmTools: ToolMap = {
  ...customerTools,
  ...contactTools,
  ...interactionTools,
  ...dashboardTools,
};

export function registerCRMTools(server: McpServer, ctx: ToolContext) {
  registerToolMap(server, crmTools, ctx);
}
