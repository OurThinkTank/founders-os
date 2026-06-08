// ============================================================
// Founders OS - RSS Feed Management Tools
// ============================================================
// Pattern A (stateless ToolMap). All tools create their own
// Supabase client inline. Feed metadata is shared via
// feed_catalog; subscriptions are per-user in feeds.
// ============================================================

import { z } from "zod";
import type { ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import { fetchFeedContent, chunkArray } from "./fetcher.js";
import { invalidateCache } from "./cache.js";
import { STARTER_FEEDS } from "./data/starter-feeds.js";
import {
  SubscribeFeedInput,
  UnsubscribeFeedInput,
  ListFeedsInput,
  PinFeedInput,
  RefreshFeedsInput,
} from "./types.js";

export const feedTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // subscribe_feed
  // ──────────────────────────────────────────────────────────
  subscribe_feed: {
    title: "Subscribe to Feed",
    description:
      "Subscribe to an RSS, Atom, or JSON Feed. Fetches once to populate metadata " +
      "if this is the first subscription to this URL in the company. Tags classify " +
      "the feed (e.g. ['tech', 'ai']). Set pinned=true to include in morning briefing.",
    parameters: SubscribeFeedInput,
    handler: async (ctx: ToolContext, {
      url,
      tags = ["other"],
      pinned = false,
    }: {
      url: string;
      tags?: string[];
      pinned?: boolean;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      // ── Upsert catalog entry (shared metadata) ──
      let catalogId: string;
      const { data: existing } = await supabase
        .from("feed_catalog")
        .select("id")
        .eq("company_id", companyId)
        .eq("url", url)
        .maybeSingle();

      if (existing) {
        catalogId = existing.id;
      } else {
        // First subscription to this URL in the company - fetch metadata
        const parsed = await fetchFeedContent(url);
        const { data: catalog, error: catErr } = await supabase
          .from("feed_catalog")
          .insert({
            url,
            title: parsed.title,
            description: parsed.description,
            site_url: parsed.site_url,
            icon_url: parsed.icon_url,
            company_id: companyId,
          })
          .select("id")
          .single();

        if (catErr) {
          // Race condition - another user created it simultaneously
          if (catErr.code === "23505") {
            const { data: retry } = await supabase
              .from("feed_catalog")
              .select("id")
              .eq("company_id", companyId)
              .eq("url", url)
              .single();
            if (!retry) throw new Error(`Failed to create catalog entry: ${catErr.message}`);
            catalogId = retry.id;
          } else {
            throw new Error(`Failed to create catalog entry: ${catErr.message}`);
          }
        } else {
          catalogId = catalog.id;
        }
      }

      // ── Create user subscription ──
      const { data: feed, error: feedErr } = await supabase
        .from("feeds")
        .insert({
          catalog_id: catalogId,
          tags,
          pinned,
          company_id: companyId,
          user_id: userId,
        })
        .select("id, tags, pinned, created_at")
        .single();

      if (feedErr) {
        if (feedErr.code === "23505") {
          throw new Error("Already subscribed to this feed.");
        }
        throw new Error(`Failed to subscribe: ${feedErr.message}`);
      }

      // Fetch catalog metadata for the response
      const { data: catMeta } = await supabase
        .from("feed_catalog")
        .select("title, url, description, site_url, icon_url")
        .eq("id", catalogId)
        .single();

      return {
        success: true,
        feed: { ...feed, ...catMeta },
        message: `Subscribed to "${catMeta?.title ?? url}"${pinned ? " (pinned)" : ""}.`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // unsubscribe_feed
  // ──────────────────────────────────────────────────────────
  unsubscribe_feed: {
    title: "Unsubscribe from Feed",
    description:
      "Unsubscribe from a feed. Only removes your subscription - other team members " +
      "and the shared catalog entry are not affected. Bookmarks from this feed are preserved.",
    parameters: UnsubscribeFeedInput,
    handler: async (ctx: ToolContext, { feed_id }: { feed_id: string }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      // Get feed info for the response message
      const { data: feed } = await supabase
        .from("feeds")
        .select("id, catalog_id, feed_catalog(title)")
        .eq("id", feed_id)
        .eq("company_id", companyId)
        .eq("user_id", userId)
        .single();

      if (!feed) throw new Error(`Feed ${feed_id} not found or not yours.`);

      const { error } = await supabase
        .from("feeds")
        .delete()
        .eq("id", feed_id)
        .eq("company_id", companyId)
        .eq("user_id", userId);

      if (error) throw new Error(`Failed to unsubscribe: ${error.message}`);

      const title = (feed as Record<string, unknown>).feed_catalog
        ? ((feed as Record<string, unknown>).feed_catalog as Record<string, unknown>).title
        : feed_id;

      return {
        success: true,
        message: `Unsubscribed from "${title}".`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_feeds
  // ──────────────────────────────────────────────────────────
  list_feeds: {
    title: "List Feeds",
    description:
      "List all subscribed RSS feeds, optionally filtered by tag or pinned status. " +
      "Returns feed metadata from the shared catalog along with per-user tags and pinned status.",
    parameters: ListFeedsInput,
    handler: async (ctx: ToolContext, {
      tag,
      pinned_only = false,
    }: {
      tag?: string;
      pinned_only?: boolean;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      let query = supabase
        .from("feeds")
        .select("id, tags, pinned, last_fetched_at, created_at, feed_catalog(url, title, description, site_url, icon_url)")
        .eq("company_id", companyId)
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (pinned_only) {
        query = query.eq("pinned", true);
      }
      if (tag) {
        query = query.contains("tags", [tag]);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list feeds: ${error.message}`);

      // Flatten the catalog join for cleaner output
      const feeds = (data ?? []).map((row: Record<string, unknown>) => {
        const catalog = row.feed_catalog as Record<string, unknown> | null;
        return {
          id: row.id,
          url: catalog?.url,
          title: catalog?.title,
          description: catalog?.description,
          site_url: catalog?.site_url,
          icon_url: catalog?.icon_url,
          tags: row.tags,
          pinned: row.pinned,
          last_fetched_at: row.last_fetched_at,
        };
      });

      return { feeds, total: feeds.length };
    },
  },

  // ──────────────────────────────────────────────────────────
  // pin_feed
  // ──────────────────────────────────────────────────────────
  pin_feed: {
    title: "Pin Feed",
    description:
      "Pin a feed so it appears in the morning briefing. Pinned feeds are fetched " +
      "during session start to generate headline summaries.",
    parameters: PinFeedInput,
    handler: async (ctx: ToolContext, { feed_id }: { feed_id: string }) => {
      const supabase = ctx.db;
      const { error } = await supabase
        .from("feeds")
        .update({ pinned: true })
        .eq("id", feed_id)
        .eq("company_id", ctx.companyId)
        .eq("user_id", ctx.userId);

      if (error) throw new Error(`Failed to pin feed: ${error.message}`);
      return { success: true, message: "Feed pinned. It will now appear in your morning briefing." };
    },
  },

  // ──────────────────────────────────────────────────────────
  // unpin_feed
  // ──────────────────────────────────────────────────────────
  unpin_feed: {
    title: "Unpin Feed",
    description:
      "Unpin a feed so it no longer appears in the morning briefing. " +
      "The feed remains subscribed - you just won't see headlines in session start.",
    parameters: PinFeedInput, // same shape - just needs feed_id
    handler: async (ctx: ToolContext, { feed_id }: { feed_id: string }) => {
      const supabase = ctx.db;
      const { error } = await supabase
        .from("feeds")
        .update({ pinned: false })
        .eq("id", feed_id)
        .eq("company_id", ctx.companyId)
        .eq("user_id", ctx.userId);

      if (error) throw new Error(`Failed to unpin feed: ${error.message}`);
      return { success: true, message: "Feed unpinned. It will no longer appear in your morning briefing." };
    },
  },

  // ──────────────────────────────────────────────────────────
  // import_starter_feeds
  // ──────────────────────────────────────────────────────────
  import_starter_feeds: {
    title: "Import Starter Feeds",
    description:
      "Import a curated starter feed list covering tech, AI, business, news, crypto, " +
      "engineering, and more. Skips any feeds you're already subscribed to. " +
      "A subset of feeds are pinned by default for the morning briefing.",
    parameters: z.object({}),
    handler: async (ctx: ToolContext, _params: Record<string, never>) => {
      // _params keeps handler.length === 2 so the registerToolMap
      // dispatcher routes this as a contextual handler. Without it,
      // length === 1 and ctx ends up bound to the params object at
      // runtime, producing `undefined.from(...)` errors.
      void _params;
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      const imported: { title: string; pinned: boolean }[] = [];
      const skipped: string[] = [];
      const errors: { url: string; error: string }[] = [];

      for (const starter of STARTER_FEEDS) {
        try {
          // ── Check/create catalog entry ──
          let catalogId: string;
          let title: string;

          const { data: existing } = await supabase
            .from("feed_catalog")
            .select("id, title")
            .eq("company_id", companyId)
            .eq("url", starter.url)
            .maybeSingle();

          if (existing) {
            catalogId = existing.id;
            title = existing.title;
          } else {
            const parsed = await fetchFeedContent(starter.url);
            title = parsed.title;
            const { data: catalog, error: catErr } = await supabase
              .from("feed_catalog")
              .upsert(
                {
                  url: starter.url,
                  title: parsed.title,
                  description: parsed.description,
                  site_url: parsed.site_url,
                  icon_url: parsed.icon_url,
                  company_id: companyId,
                },
                { onConflict: "company_id,url", ignoreDuplicates: false }
              )
              .select("id")
              .single();

            if (catErr) throw new Error(catErr.message);
            catalogId = catalog.id;
          }

          // ── Check if user already subscribed ──
          const { data: existingSub } = await supabase
            .from("feeds")
            .select("id")
            .eq("company_id", companyId)
            .eq("user_id", userId)
            .eq("catalog_id", catalogId)
            .maybeSingle();

          if (existingSub) {
            skipped.push(title);
            continue;
          }

          // ── Create subscription ──
          const pinned = starter.pinDefault ?? false;
          const { error: subErr } = await supabase.from("feeds").insert({
            catalog_id: catalogId,
            tags: starter.tags,
            pinned,
            company_id: companyId,
            user_id: userId,
          });

          if (subErr) throw new Error(subErr.message);
          imported.push({ title, pinned });
        } catch (error) {
          errors.push({
            url: starter.url,
            error: (error as Error).message,
          });
        }
      }

      const pinnedCount = imported.filter((f) => f.pinned).length;

      return {
        imported: imported.map((f) => f.title),
        imported_count: imported.length,
        pinned_count: pinnedCount,
        skipped,
        skipped_count: skipped.length,
        errors,
        error_count: errors.length,
        summary:
          `Imported ${imported.length} feeds (${pinnedCount} pinned for briefing), ` +
          `skipped ${skipped.length}, ${errors.length} errors.`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // refresh_feeds
  // ──────────────────────────────────────────────────────────
  refresh_feeds: {
    title: "Refresh Feeds",
    description:
      "Force-refresh feed data by clearing the cache. Optionally refresh a specific feed " +
      "and update its catalog metadata. If no feed_id is given, clears the entire cache.",
    parameters: RefreshFeedsInput,
    handler: async (ctx: ToolContext, { feed_id }: { feed_id?: string }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      if (feed_id) {
        // Refresh a specific feed
        const { data: feed } = await supabase
          .from("feeds")
          .select("id, catalog_id, feed_catalog(url, title)")
          .eq("id", feed_id)
          .eq("company_id", companyId)
          .eq("user_id", userId)
          .single();

        if (!feed) throw new Error(`Feed ${feed_id} not found.`);

        const catalog = (feed as Record<string, unknown>).feed_catalog as Record<string, unknown>;
        const url = catalog.url as string;

        // Clear cache so next fetch is fresh
        invalidateCache(url);

        // Re-fetch and update catalog metadata
        const parsed = await fetchFeedContent(url);
        await supabase
          .from("feed_catalog")
          .update({
            title: parsed.title,
            description: parsed.description,
            site_url: parsed.site_url,
            icon_url: parsed.icon_url,
          })
          .eq("id", (feed as Record<string, unknown>).catalog_id);

        // Update last_fetched_at
        await supabase
          .from("feeds")
          .update({ last_fetched_at: new Date().toISOString() })
          .eq("id", feed_id);

        return {
          success: true,
          feed: catalog.title,
          items_available: parsed.items.length,
          message: `Refreshed "${catalog.title}" - ${parsed.items.length} items available.`,
        };
      } else {
        // Clear entire cache
        const { clearCache } = await import("./cache.js");
        clearCache();
        return {
          success: true,
          message: "Feed cache cleared. Next fetch will pull fresh data.",
        };
      }
    },
  },
};
