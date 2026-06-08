// ============================================================
// Founders OS - RSS Feed Item Tools
// ============================================================
// On-demand fetch tools. Items are not stored in the database.
// They are fetched live (cache-first) and returned as numbered
// lists. The user picks an item by number to read full content.
// ============================================================

import type { ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import { getCachedItems, getCachedItemByIndex } from "./cache.js";
import { chunkArray } from "./fetcher.js";
import { GetFeedItemsInput, ReadFeedItemInput } from "./types.js";

/** Fetch the user's feeds with catalog URLs, optionally filtered. */
async function getUserFeeds(
  ctx: ToolContext,
  options: {
    feed_id?: string;
    tag?: string;
  }
): Promise<{ id: string; url: string; title: string; tags: string[] }[]> {
  let query = ctx.db
    .from("feeds")
    .select("id, tags, feed_catalog(url, title)")
    .eq("company_id", ctx.companyId)
    .eq("user_id", ctx.userId);

  if (options.feed_id) {
    query = query.eq("id", options.feed_id);
  }
  if (options.tag) {
    query = query.contains("tags", [options.tag]);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list feeds: ${error.message}`);

  return (data ?? []).map((row: Record<string, unknown>) => {
    const catalog = row.feed_catalog as Record<string, unknown> | null;
    return {
      id: row.id as string,
      url: (catalog?.url as string) ?? "",
      title: (catalog?.title as string) ?? "Unknown",
      tags: row.tags as string[],
    };
  });
}

export const itemTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // get_feed_items
  // ──────────────────────────────────────────────────────────
  get_feed_items: {
    title: "Get Feed Items",
    description:
      "Fetch the latest items from subscribed feeds. Returns a numbered summary list " +
      "with title, author, date, and whether full content is available. " +
      "Use read_feed_item with the item number to get full content. " +
      "Filter by feed_id for a specific feed, or by tag for a topic.",
    parameters: GetFeedItemsInput,
    handler: async (ctx: ToolContext, {
      feed_id,
      tag,
      limit = 25,
    }: {
      feed_id?: string;
      tag?: string;
      limit?: number;
    }) => {
      const feeds = await getUserFeeds(ctx, { feed_id, tag });

      if (feeds.length === 0) {
        return {
          items: [],
          message: feed_id
            ? "Feed not found or not subscribed."
            : tag
              ? `No feeds with tag "${tag}".`
              : "No feeds subscribed. Use import_starter_feeds to get started.",
        };
      }

      // Fetch items from all matching feeds (parallel, capped at 5 concurrent)
      const allItems: {
        feed_title: string;
        feed_url: string;
        feed_tags: string[];
        index: number;
        title: string;
        link?: string;
        summary?: string;
        author?: string;
        published_at?: string;
        has_full_content: boolean;
      }[] = [];

      const chunks = chunkArray(feeds, 5);
      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map(async (feed) => {
            const items = await getCachedItems(feed.url);
            return items.map((item) => ({
              feed_title: feed.title,
              feed_url: feed.url,
              feed_tags: feed.tags,
              index: item.index,
              title: item.title,
              link: item.link,
              summary: item.summary?.slice(0, 200),
              author: item.author,
              published_at: item.published_at,
              has_full_content: item.has_full_content,
            }));
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled") {
            allItems.push(...result.value);
          }
        }
      }

      // Sort by published_at descending
      allItems.sort((a, b) => {
        const da = a.published_at ?? "";
        const db = b.published_at ?? "";
        return db.localeCompare(da);
      });

      const sliced = allItems.slice(0, limit);

      return {
        items: sliced,
        total: allItems.length,
        showing: sliced.length,
        hint:
          "To read full content, use read_feed_item with the feed_url and item index number. " +
          "Items marked has_full_content=true have full article text available.",
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // read_feed_item
  // ──────────────────────────────────────────────────────────
  read_feed_item: {
    title: "Read Feed Item",
    description:
      "Read the full content of a feed item by its index number (from get_feed_items). " +
      "If the feed provides full article content, it is returned as HTML. " +
      "If only a summary is available, the link to the original article is returned instead.",
    parameters: ReadFeedItemInput,
    handler: async (
      _ctx: ToolContext,
      {
        feed_url,
        item_index,
      }: {
        feed_url: string;
        item_index: number;
      }
    ) => {
      // read_feed_item does no DB work - it reads from the in-memory item
      // cache and (on miss) re-fetches the feed. The ctx parameter is
      // required for the contextual signature but unused.
      const item = getCachedItemByIndex(feed_url, item_index);

      if (!item) {
        // Cache may have expired - try fetching fresh
        const items = await getCachedItems(feed_url);
        const freshItem = items.find((i) => i.index === item_index);
        if (!freshItem) {
          throw new Error(
            `Item #${item_index} not found for feed ${feed_url}. ` +
            `The cache may have expired. Try get_feed_items again to refresh.`
          );
        }
        return formatReadResponse(freshItem);
      }

      return formatReadResponse(item);
    },
  },
};

function formatReadResponse(item: {
  title: string;
  link?: string;
  summary?: string;
  content?: string;
  author?: string;
  published_at?: string;
  has_full_content: boolean;
}) {
  if (item.has_full_content && item.content) {
    return {
      title: item.title,
      author: item.author,
      published_at: item.published_at,
      link: item.link,
      content: item.content,
      content_type: "full_article",
    };
  }

  return {
    title: item.title,
    author: item.author,
    published_at: item.published_at,
    link: item.link,
    summary: item.summary,
    content_type: "summary_only",
    hint: item.link
      ? "Full content not available in the feed. Open the link to read the full article."
      : "Full content not available and no link provided.",
  };
}
