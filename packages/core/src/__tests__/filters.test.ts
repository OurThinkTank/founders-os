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
import { resolveTagList, liveTasks } from "../tools/filters.js";

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

type Call = [string, unknown];

/** Minimal stand-in for the Supabase builder: records the chain. */
function fakeDb(calls: Call[]) {
  const builder: Record<string, (...args: unknown[]) => unknown> = {
    select: (columns: unknown, options: unknown) => {
      calls.push(["select", { columns, options }]);
      return builder;
    },
    is: (column: unknown, value: unknown) => {
      calls.push(["is", { column, value }]);
      return builder;
    },
    eq: (column: unknown, value: unknown) => {
      calls.push(["eq", { column, value }]);
      return builder;
    },
  };
  return {
    from: (table: string) => {
      calls.push(["from", table]);
      return builder as never;
    },
  };
}

describe("liveTasks", () => {
  it("reads the tasks table", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls));
    expect(calls[0]).toEqual(["from", "tasks"]);
  });

  it("excludes archived rows", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls));
    expect(calls).toContainEqual(["is", { column: "archived_at", value: null }]);
  });

  it("excludes soft-deleted rows", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls));
    expect(calls).toContainEqual(["is", { column: "deleted_at", value: null }]);
  });

  it("selects all columns by default", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls));
    expect(calls[1]).toEqual(["select", { columns: "*", options: undefined }]);
  });

  it("passes through an explicit column list", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls), "id, title, due_date");
    expect(calls[1]).toEqual([
      "select",
      { columns: "id, title, due_date", options: undefined },
    ]);
  });

  it("passes through count options so head-count reads stay filtered", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls), "id", { count: "exact", head: true });
    expect(calls[1]).toEqual([
      "select",
      { columns: "id", options: { count: "exact", head: true } },
    ]);
    expect(calls).toContainEqual(["is", { column: "archived_at", value: null }]);
  });

  it("returns the builder so callers can keep chaining", () => {
    const calls: Call[] = [];
    liveTasks(fakeDb(calls)).eq("company_id", "ourthinktank");
    expect(calls).toContainEqual([
      "eq",
      { column: "company_id", value: "ourthinktank" },
    ]);
  });
});
