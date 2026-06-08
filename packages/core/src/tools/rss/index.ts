// ============================================================
// RSS Tool Group - Registration
// ============================================================
// Pattern A (stateless ToolMap). No shared state needed -
// feeds are in Supabase, items are fetched on demand with
// a module-level in-memory cache.
//
// 15 tools across 4 groups:
//   Feed management : subscribe_feed, unsubscribe_feed,
//                     list_feeds, pin_feed, unpin_feed,
//                     refresh_feeds, import_starter_feeds
//   Item reading    : get_feed_items, read_feed_item
//   Bookmarks       : bookmark_item, list_bookmarks,
//                     remove_bookmark
//   Briefing        : get_feed_briefing
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolMap, type ToolMap } from "../register.js";
import { feedTools } from "./feeds.js";
import { itemTools } from "./items.js";
import { bookmarkTools } from "./bookmarks.js";
import { briefingTools } from "./briefing.js";
import type { ToolContext } from "../../types/context.js";

// Aggregate raw map for transport-agnostic binding (barrel export). The
// registration function below keeps its four separate registerToolMap calls
// (unchanged behavior); this combined map is for non-stdio wrappers only.
export const rssTools: ToolMap = {
  ...feedTools,
  ...itemTools,
  ...bookmarkTools,
  ...briefingTools,
};

export function registerRSSTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, feedTools, ctx);
  registerToolMap(server, itemTools, ctx);
  registerToolMap(server, bookmarkTools, ctx);
  registerToolMap(server, briefingTools, ctx);
}
