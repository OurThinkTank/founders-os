// ============================================================
// Founders OS - Shared filter params
// ============================================================
// Tag filtering is identical across every retrieval tool, so the
// schema fragment and matching logic live here. `tags` is the
// general (multi-value) filter; `tag` is a single-value shorthand.
// ============================================================

import { z } from "zod";

export const tagFilterParams = {
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Filter to items carrying these tags. Combined per `tag_match` " +
      "(default 'all': the item must carry every listed tag)."
    ),
  tag_match: z
    .enum(["all", "any"])
    .optional()
    .describe(
      "How to combine `tags`: 'all' (item has every tag, default) or " +
      "'any' (item has at least one of them)."
    ),
  tag: z
    .string()
    .optional()
    .describe("Convenience filter for a single tag. Use `tags` for multiple."),
};

/**
 * Resolve the effective tag list from the `tags` array or the single-value
 * `tag` shorthand. Returns null when no tag filter was provided.
 */
export function resolveTagList(tag?: string, tags?: string[]): string[] | null {
  if (tags && tags.length > 0) return tags;
  if (tag) return [tag];
  return null;
}
