// ────────────────────────────────────────
// In-memory feed cache with TTL
// ────────────────────────────────────────
// Module-level cache shared across tool calls within a process.
// Not persisted. Prevents re-fetching the same feed multiple
// times within a session (e.g. list items then read one).

import { fetchFeedContent } from "./fetcher.js";
import type { ParsedFeedItem } from "./types.js";

// ── Cached item shape ──────────────────────────────────────

export interface CachedItem {
  /** Index within the cached feed (1-based for user-facing numbering) */
  index: number;
  guid: string;
  title: string;
  link?: string;
  summary?: string;
  content?: string;
  author?: string;
  published_at?: string;
  /** True when the feed provides full article content beyond the summary */
  has_full_content: boolean;
}

interface CachedFeed {
  items: CachedItem[];
  fetchedAt: number;
}

// ── Cache configuration ────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const feedCache = new Map<string, CachedFeed>();

// ── Public API ─────────────────────────────────────────────

/**
 * Get items for a feed URL, fetching live if not cached or expired.
 * Returns cached items sorted newest-first with 1-based indexes.
 */
export async function getCachedItems(url: string): Promise<CachedItem[]> {
  const cached = feedCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.items;
  }

  const parsed = await fetchFeedContent(url);
  const items = toCachedItems(parsed.items);

  feedCache.set(url, { items, fetchedAt: Date.now() });
  return items;
}

/**
 * Get a single item by 1-based index from a cached feed.
 * Returns undefined if the feed is not cached or the index is out of range.
 */
export function getCachedItemByIndex(
  url: string,
  index: number
): CachedItem | undefined {
  const cached = feedCache.get(url);
  if (!cached) return undefined;
  return cached.items.find((item) => item.index === index);
}

/**
 * Get a single item by guid from a cached feed.
 */
export function getCachedItemByGuid(
  url: string,
  guid: string
): CachedItem | undefined {
  const cached = feedCache.get(url);
  if (!cached) return undefined;
  return cached.items.find((item) => item.guid === guid);
}

/**
 * Invalidate the cache for a specific URL, forcing a fresh fetch next time.
 */
export function invalidateCache(url: string): void {
  feedCache.delete(url);
}

/**
 * Clear the entire cache. Useful for testing.
 */
export function clearCache(): void {
  feedCache.clear();
}

// ── Internal helpers ───────────────────────────────────────

function toCachedItems(parsed: ParsedFeedItem[]): CachedItem[] {
  // Sort newest first by published_at
  const sorted = [...parsed].sort((a, b) => {
    const da = a.published_at ?? "";
    const db = b.published_at ?? "";
    return db.localeCompare(da);
  });

  return sorted.map((item, i) => {
    const summary = item.summary?.trim() ?? "";
    const content = item.content?.trim() ?? "";

    // has_full_content is true when content exists and differs from summary
    // (some feeds put the same text in both fields)
    const has_full_content =
      content.length > 0 && content !== summary && content.length > summary.length;

    return {
      index: i + 1,
      guid: item.guid,
      title: item.title,
      link: item.link,
      summary: item.summary,
      content: has_full_content ? item.content : undefined,
      author: item.author,
      published_at: item.published_at,
      has_full_content,
    };
  });
}
