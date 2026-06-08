// ============================================================
// Founders OS - RSS Feed Bookmark Tools
// ============================================================
// Bookmarks snapshot feed item content into the database so
// saved articles survive beyond the in-memory cache TTL.
// Per-user, scoped to (company_id, user_id).
// ============================================================

import { z } from "zod";
import type { ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import { getCachedItemByIndex } from "./cache.js";
import { BookmarkItemInput, ListBookmarksInput, RemoveBookmarkInput } from "./types.js";

export const bookmarkTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // bookmark_item
  // ──────────────────────────────────────────────────────────
  bookmark_item: {
    title: "Bookmark Feed Item",
    description:
      "Save a feed item for later. Snapshots the item content so it persists beyond " +
      "the cache. Use the feed_url and item index number from get_feed_items.",
    parameters: BookmarkItemInput,
    handler: async (ctx: ToolContext, {
      feed_url,
      item_index,
    }: {
      feed_url: string;
      item_index: number;
    }) => {
      const item = getCachedItemByIndex(feed_url, item_index);
      if (!item) {
        throw new Error(
          `Item #${item_index} not found in cache for ${feed_url}. ` +
          `Run get_feed_items first to populate the cache.`
        );
      }

      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      // Look up the user's feed and catalog for this URL
      const { data: feedRow } = await supabase
        .from("feeds")
        .select("id, catalog_id, feed_catalog(title, url)")
        .eq("company_id", companyId)
        .eq("user_id", userId)
        .eq("feed_catalog.url", feed_url)
        .maybeSingle();

      const catalog = feedRow
        ? (feedRow as Record<string, unknown>).feed_catalog as Record<string, unknown> | null
        : null;

      const { data: bookmark, error } = await supabase
        .from("feed_bookmarks")
        .upsert(
          {
            feed_id: feedRow?.id ?? null,
            catalog_id: feedRow
              ? (feedRow as Record<string, unknown>).catalog_id
              : null,
            guid: item.guid,
            title: item.title,
            link: item.link,
            summary: item.summary,
            content: item.content,
            author: item.author,
            published_at: item.published_at,
            feed_title: (catalog?.title as string) ?? null,
            feed_url,
            company_id: companyId,
            user_id: userId,
          },
          { onConflict: "company_id,user_id,guid", ignoreDuplicates: false }
        )
        .select("id, title, created_at")
        .single();

      if (error) throw new Error(`Failed to bookmark: ${error.message}`);

      return {
        success: true,
        bookmark,
        message: `Bookmarked "${item.title}".`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_bookmarks
  // ──────────────────────────────────────────────────────────
  list_bookmarks: {
    title: "List Bookmarks",
    description:
      "List saved feed item bookmarks, newest first. Returns title, summary, " +
      "source feed, and link for each bookmark.",
    parameters: ListBookmarksInput,
    handler: async (ctx: ToolContext, {
      limit = 25,
      offset = 0,
    }: {
      limit?: number;
      offset?: number;
    }) => {
      const supabase = ctx.db;

      const { data, error, count } = await supabase
        .from("feed_bookmarks")
        .select("id, title, link, summary, author, published_at, feed_title, feed_url, created_at", {
          count: "exact",
        })
        .eq("company_id", ctx.companyId)
        .eq("user_id", ctx.userId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw new Error(`Failed to list bookmarks: ${error.message}`);

      return {
        bookmarks: data ?? [],
        total: count ?? 0,
        showing: data?.length ?? 0,
        offset,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_bookmark
  // ──────────────────────────────────────────────────────────
  remove_bookmark: {
    title: "Remove Bookmark",
    description: "Remove a saved bookmark by its ID.",
    parameters: RemoveBookmarkInput,
    handler: async (ctx: ToolContext, { bookmark_id }: { bookmark_id: string }) => {
      const supabase = ctx.db;

      const { error } = await supabase
        .from("feed_bookmarks")
        .delete()
        .eq("id", bookmark_id)
        .eq("company_id", ctx.companyId)
        .eq("user_id", ctx.userId);

      if (error) throw new Error(`Failed to remove bookmark: ${error.message}`);

      return { success: true, message: "Bookmark removed." };
    },
  },
};
