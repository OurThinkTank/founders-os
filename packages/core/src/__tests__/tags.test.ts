// ============================================================
// Tests for src/tools/tags/index.ts - toSlug + validateTags
// ============================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toSlug } from "../tools/tags/index.js";

// ── toSlug (pure function, no mocking needed) ─────────────────────────────

describe("toSlug", () => {
  it("TC-S01: lowercases the input", () => {
    expect(toSlug("Hello")).toBe("hello");
  });

  it("TC-S02: trims whitespace", () => {
    expect(toSlug("  hello  ")).toBe("hello");
  });

  it("TC-S03: converts spaces to hyphens", () => {
    expect(toSlug("Q2 2026")).toBe("q2-2026");
  });

  it("TC-S04: strips special characters (no space inserted, so adjacent words merge)", () => {
    // "/" and "!" are stripped by [^\w\s-], producing no space between chars
    // "foo/bar!baz" → remove / and ! → "foobarbaz" (no separator is inserted)
    expect(toSlug("foo/bar!baz")).toBe("foobarbaz");
    // But a space separator IS kept: "foo bar" → "foo-bar"
    expect(toSlug("foo bar")).toBe("foo-bar");
  });

  it("TC-S05: collapses consecutive hyphens", () => {
    expect(toSlug("foo--bar")).toBe("foo-bar");
    expect(toSlug("foo   bar")).toBe("foo-bar");
  });

  it("TC-S06: strips leading and trailing hyphens", () => {
    expect(toSlug("-foo-")).toBe("foo");
    expect(toSlug("--edge--")).toBe("edge");
  });

  it("TC-S07: handles empty string", () => {
    expect(toSlug("")).toBe("");
  });

  it("TC-S08: handles all-whitespace input", () => {
    expect(toSlug("   ")).toBe("");
  });

  it("TC-S09: preserves digits", () => {
    expect(toSlug("v2 launch")).toBe("v2-launch");
  });

  it("TC-S10: handles multi-word org names", () => {
    expect(toSlug("Life Science Outsourcing")).toBe("life-science-outsourcing");
  });

  it("TC-S11: treats # @ ! as special chars that get stripped", () => {
    // The prefix chars # @ ! are not \w, not whitespace, not hyphen
    // so they get stripped; "#founders-os" slugifies to "founders-os"
    // which is the expected canonical slug form
    expect(toSlug("#founders-os")).toBe("founders-os");
    expect(toSlug("@claude")).toBe("claude");
    expect(toSlug("!blocked")).toBe("blocked");
  });

  it("TC-S12: handles unicode by stripping non-ASCII word chars", () => {
    // Non-ASCII chars that aren't matched by \w (in JS regex) get stripped
    const result = toSlug("café");
    // "c", "a", "f", "é" - é is matched by \w in Unicode mode? In JS without /u flag,
    // \w is [a-zA-Z0-9_]. "café" → strip é → "caf"
    expect(result).toMatch(/^[a-z0-9-]*$/);
  });
});

// ── validateTags (requires Supabase mock) ──────────────────────────────────
// vi.mock is hoisted, so the factory cannot reference symbols defined later
// in the module. Use vi.hoisted() to define shared mock state that is
// guaranteed to exist when the factory runs.

const { mockRows, insertSpy } = vi.hoisted(() => ({
  mockRows: {
    registry: [] as { name: string; slug: string }[],
    contacts: [] as { first_name: string; last_name: string }[],
    customers: [] as { organization_name: string }[],
  },
  insertSpy: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock("../supabase.js", () => {
  const buildQuery = (rows: unknown[]) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      // .in() is used by validateTags' projects query (status filter)
      in: () => q,
      // .is() is used by validateTags' deleted_at filter on every query
      is: () => q,
      insert: (payload: unknown) => insertSpy(payload),
      data: rows,
      error: null,
    };
    return q;
  };

  return {
    createServiceClient: () => ({
      from: (table: string) => {
        if (table === "tag_registry") return buildQuery(mockRows.registry);
        if (table === "contacts") return buildQuery(mockRows.contacts);
        if (table === "customers") return buildQuery(mockRows.customers);
        return buildQuery([]);
      },
    }),
  };
});

describe("validateTags — mock-based", () => {
  beforeEach(() => {
    mockRows.registry = [];
    mockRows.contacts = [];
    mockRows.customers = [];
    insertSpy.mockClear();
  });

  // After the tags-domain ctx migration (2026-05-28), validateTags takes
  // (ctx, tags, opts). The mockCtx pulls its db from the mocked supabase
  // module above, so the contacts/customers/registry/projects fetches still
  // route through the buildQuery() factory and respect mockRows.
  type MockedToolContext = import("../types/context.js").ToolContext;
  const buildMockCtx = async (): Promise<MockedToolContext> => {
    const { createServiceClient } = await import("../supabase.js");
    const client = createServiceClient();
    return {
      db: client,
      admin: client,
      companyId: "default",
      userId: "default",
      identityMode: "env",
      isSoloMode: true,
    };
  };

  it("TC-T01: returns no warnings for an empty tag array", async () => {
    const { validateTags } = await import("../tools/tags/index.js");
    const ctx = await buildMockCtx();
    const result = await validateTags(ctx, []);
    expect(result.warnings).toHaveLength(0);
    expect(result.auto_registered).toHaveLength(0);
  });

  it("TC-T02: filters out whitespace-only tags", async () => {
    const { validateTags } = await import("../tools/tags/index.js");
    const ctx = await buildMockCtx();
    const result = await validateTags(ctx, ["  ", "\t", ""]);
    expect(result.warnings).toHaveLength(0);
  });

  it("TC-T03: orphan prefix produces a warning", async () => {
    const { validateTags } = await import("../tools/tags/index.js");
    const ctx = await buildMockCtx();
    const result = await validateTags(ctx, ["#"]);
    expect(result.warnings.some((w) => w.code === "orphan_prefix")).toBe(true);
  });

  it("TC-T04: preview mode surfaces the warning but registers nothing", async () => {
    mockRows.contacts = [{ first_name: "Alex", last_name: "Chen" }];
    const { validateTags } = await import("../tools/tags/index.js");
    const ctx = await buildMockCtx();
    const result = await validateTags(ctx, ["Alex"], { preview: true });
    const bare = result.warnings.find((w) => w.code === "bare_name");
    expect(bare?.suggestion).toBe("@Alex");
    expect(result.auto_registered).toHaveLength(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("TC-T05: default (non-preview) still auto-registers the tag", async () => {
    mockRows.contacts = [{ first_name: "Alex", last_name: "Chen" }];
    const { validateTags } = await import("../tools/tags/index.js");
    const ctx = await buildMockCtx();
    const result = await validateTags(ctx, ["Alex"]);
    expect(result.warnings.some((w) => w.code === "bare_name")).toBe(true);
    expect(result.auto_registered).toContain("Alex");
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});
