// ============================================================
// Founders OS - Shared tag-filter resolution
// ============================================================
// resolveTagList() backs the multi-tag filter on every retrieval
// tool (list_tasks, list_customers, search_customers, list_accounts,
// list_categories, list_transactions). `tags` (array) is the general
// filter; `tag` is a single-value shorthand. `tags` wins when both
// are present; an empty array is treated as "no tags array".
// ============================================================

import { describe, it, expect } from "vitest";
import { resolveTagList } from "../tools/filters.js";

describe("resolveTagList", () => {
  it("returns null when no tag filter is provided", () => {
    expect(resolveTagList(undefined, undefined)).toBeNull();
  });

  it("returns a one-element list for the single-tag shorthand", () => {
    expect(resolveTagList("fundraising", undefined)).toEqual(["fundraising"]);
  });

  it("returns the tags array when provided", () => {
    expect(resolveTagList(undefined, ["fundraising", "urgent"])).toEqual([
      "fundraising",
      "urgent",
    ]);
  });

  it("prefers the tags array over the single-tag shorthand", () => {
    expect(resolveTagList("ignored", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("treats an empty tags array as absent and falls back to tag", () => {
    expect(resolveTagList("x", [])).toEqual(["x"]);
    expect(resolveTagList(undefined, [])).toBeNull();
  });
});
