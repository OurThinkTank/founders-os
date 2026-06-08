// ============================================================
// Founders OS - RSS Feed Briefing Tools
// ============================================================
// Lightweight briefing for the morning dashboard. Only fetches
// pinned feeds. Returns one headline per tag, capped at a
// configurable max (default 8).
// ============================================================

import type { ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import { getCachedItems, type CachedItem } from "./cache.js";
import { chunkArray } from "./fetcher.js";
import { GetFeedBriefingInput } from "./types.js";
import type { Render } from "../../types/render.js";

export const briefingTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // get_feed_briefing
  // ──────────────────────────────────────────────────────────
  get_feed_briefing: {
    title: "Get Feed Briefing",
    description:
      "Generate a compact headline briefing from pinned feeds for the morning dashboard. " +
      "Returns one headline per tag, capped at 8 total. Designed to be included in " +
      "get_session_start without slowing it down. Only fetches pinned feeds. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: GetFeedBriefingInput,
    handler: async (ctx: ToolContext, { max_headlines = 8 }: { max_headlines?: number }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      // ── Get pinned feeds with their catalog URLs ──
      const { data: pinnedFeeds, error } = await supabase
        .from("feeds")
        .select("id, tags, feed_catalog(url, title)")
        .eq("company_id", companyId)
        .eq("user_id", userId)
        .eq("pinned", true);

      if (error) throw new Error(`Failed to get pinned feeds: ${error.message}`);

      if (!pinnedFeeds || pinnedFeeds.length === 0) {
        return {
          total_subscriptions: 0,
          pinned_count: 0,
          headlines: [],
          hint: "No pinned feeds. Use pin_feed to add feeds to your morning briefing, or import_starter_feeds to get started.",
        };
      }

      // Get total subscription count for context
      const { count: totalSubs } = await supabase
        .from("feeds")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .eq("user_id", userId);

      // ── Fetch pinned feeds (parallel, capped at 5 concurrent) ──
      interface FeedWithItems {
        title: string;
        url: string;
        tags: string[];
        items: CachedItem[];
      }

      const feedResults: FeedWithItems[] = [];
      const feedList = pinnedFeeds.map((row: Record<string, unknown>) => {
        const catalog = row.feed_catalog as Record<string, unknown> | null;
        return {
          tags: row.tags as string[],
          url: (catalog?.url as string) ?? "",
          title: (catalog?.title as string) ?? "Unknown",
        };
      });

      const chunks = chunkArray(feedList, 5);
      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map(async (feed) => {
            const items = await getCachedItems(feed.url);
            return { ...feed, items };
          })
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            feedResults.push(result.value);
          }
        }
      }

      // ── Build headline list: one per tag, then fill remaining slots ──
      const headlines: {
        title: string;
        feed: string;
        tag: string;
        link?: string;
        author?: string;
        published_at?: string;
        has_full_content: boolean;
      }[] = [];
      const usedTags = new Set<string>();
      const usedGuids = new Set<string>();

      // Collect all items with their feed context, sorted newest first
      const allTaggedItems: {
        item: CachedItem;
        feed: string;
        feedUrl: string;
        tag: string;
      }[] = [];

      for (const feed of feedResults) {
        for (const item of feed.items) {
          // Each item appears once per tag on its feed
          for (const tag of feed.tags) {
            allTaggedItems.push({
              item,
              feed: feed.title,
              feedUrl: feed.url,
              tag,
            });
          }
        }
      }

      // Sort newest first
      allTaggedItems.sort((a, b) => {
        const da = a.item.published_at ?? "";
        const db = b.item.published_at ?? "";
        return db.localeCompare(da);
      });

      // Pass 1: one headline per tag (most recent item per tag)
      for (const entry of allTaggedItems) {
        if (headlines.length >= max_headlines) break;
        if (usedTags.has(entry.tag)) continue;
        if (usedGuids.has(entry.item.guid)) continue;

        headlines.push({
          title: entry.item.title,
          feed: entry.feed,
          tag: entry.tag,
          link: entry.item.link,
          author: entry.item.author,
          published_at: entry.item.published_at,
          has_full_content: entry.item.has_full_content,
        });
        usedTags.add(entry.tag);
        usedGuids.add(entry.item.guid);
      }

      // Pass 2: fill remaining slots with next most recent (any tag)
      if (headlines.length < max_headlines) {
        for (const entry of allTaggedItems) {
          if (headlines.length >= max_headlines) break;
          if (usedGuids.has(entry.item.guid)) continue;

          headlines.push({
            title: entry.item.title,
            feed: entry.feed,
            tag: entry.tag,
            link: entry.item.link,
            author: entry.item.author,
            published_at: entry.item.published_at,
            has_full_content: entry.item.has_full_content,
          });
          usedGuids.add(entry.item.guid);
        }
      }

      return {
        total_subscriptions: totalSubs ?? 0,
        pinned_count: pinnedFeeds.length,
        headlines,
        hint:
          "Say 'show all tech news' or pick a headline to read more. " +
          "'pin_feed' / 'unpin_feed' to change what appears here.",
        render: {
          tier_1: {
            format_hint: "headline_list",
            instructions: {
              scope:
                "render the `headlines` array as a ranked headline list. Each " +
                "item has title, tag, feed (source), link, and published_at.",
              format:
                "compact styled list with tag badges; each row links the title " +
                "to its `link` field; feed name appears as secondary metadata. " +
                "Limit display to 6 rows by default.",
              forbidden:
                "do not omit the link; do not summarize multiple headlines into " +
                "a single bullet; do not editorialize headline text.",
            },
          },
          tier_3: {
            markdown:
              "| Tag | Headline | Source |\n" +
              "|-----|----------|--------|\n" +
              headlines
                .map(
                  (h) =>
                    `| ${h.tag} | [${h.title}](${h.link ?? ""}) | ${h.feed} |`
                )
                .join("\n"),
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
            "Do not display more than 6 rows by default - excess belongs in a follow-up.",
          ],
        } satisfies Render,
      };
    },
  },
};

/**
 * Get the feed briefing signal for get_session_start.
 * Exported so surfaces/index.ts can call it directly without
 * going through the MCP tool registration.
 */
export async function getFeedBriefingSignal(
  ctx: ToolContext,
  maxHeadlines = 8
): Promise<{
  total_subscriptions: number;
  pinned_count: number;
  headlines: { title: string; feed: string; tag: string }[];
}> {
  const handler = briefingTools.get_feed_briefing.handler as (
    ctx: ToolContext,
    params: { max_headlines?: number }
  ) => Promise<{
    total_subscriptions: number;
    pinned_count: number;
    headlines: { title: string; feed: string; tag: string }[];
  }>;

  return handler(ctx, { max_headlines: maxHeadlines });
}
