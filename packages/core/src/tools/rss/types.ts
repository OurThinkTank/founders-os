import { z } from "zod";

// ────────────────────────────────────────
// RSS Feed types and input schemas
// ────────────────────────────────────────
// Tags replace the old FeedCategory enum.
// Items are fetched on demand - no persistent item schemas needed.

// ── MCP-safe numeric fields ─────────────────────────────────
// The MCP SDK validates args against JSON Schema before Zod runs.
// z.coerce.number() still emits {"type":"number"} in JSON Schema, so
// string args get rejected. Using a union tells JSON Schema to accept
// both, then .transform(Number) coerces to number for our handlers.

const optNumId = z.union([z.number(), z.string()]).transform(Number).optional();
const optPosNum = z.union([z.number(), z.string()]).transform(Number).optional();

// ── Tool Input Schemas ──────────────────────────────────────

export const SubscribeFeedInput = z.object({
  url: z.string().url().describe("The RSS, Atom, or JSON Feed URL"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to classify this feed (e.g. ['tech', 'ai']). Default: ['other']"),
  pinned: z
    .boolean()
    .optional()
    .describe("Pin this feed so it appears in the morning briefing. Default: false"),
});

export const UnsubscribeFeedInput = z.object({
  feed_id: z.string().uuid().describe("UUID of the feed subscription to remove"),
});

export const ListFeedsInput = z.object({
  tag: z.string().optional().describe("Filter by tag (e.g. 'tech', 'news')"),
  pinned_only: z
    .boolean()
    .optional()
    .describe("Only show pinned feeds. Default: false"),
});

export const PinFeedInput = z.object({
  feed_id: z.string().uuid().describe("UUID of the feed to pin/unpin"),
});

export const GetFeedItemsInput = z.object({
  feed_id: z
    .string()
    .uuid()
    .optional()
    .describe("UUID of a specific feed. Omit to fetch across all feeds."),
  tag: z.string().optional().describe("Filter feeds by tag"),
  limit: optPosNum.describe("Max items to return (default: 25)"),
});

export const ReadFeedItemInput = z.object({
  feed_url: z.string().url().describe("URL of the feed containing the item"),
  item_index: z
    .union([z.number(), z.string()])
    .transform(Number)
    .describe("1-based item number from the get_feed_items list"),
});

export const BookmarkItemInput = z.object({
  feed_url: z.string().url().describe("URL of the feed containing the item"),
  item_index: z
    .union([z.number(), z.string()])
    .transform(Number)
    .describe("1-based item number from the get_feed_items list"),
});

export const ListBookmarksInput = z.object({
  limit: optPosNum.describe("Max bookmarks to return (default: 25)"),
  offset: optPosNum.describe("Pagination offset"),
});

export const RemoveBookmarkInput = z.object({
  bookmark_id: z.string().uuid().describe("UUID of the bookmark to remove"),
});

export const RefreshFeedsInput = z.object({
  feed_id: z
    .string()
    .uuid()
    .optional()
    .describe("Refresh a specific feed, or all if omitted"),
});

export const GetFeedBriefingInput = z.object({
  max_headlines: optPosNum.describe("Max headlines to return (default: 8)"),
});

// ── Parsed Feed Types (internal, from parser) ───────────────

export interface ParsedFeed {
  title: string;
  description?: string;
  site_url?: string;
  icon_url?: string;
  items: ParsedFeedItem[];
}

export interface ParsedFeedItem {
  guid: string;
  title: string;
  link?: string;
  content?: string;
  summary?: string;
  author?: string;
  published_at?: string;
}
