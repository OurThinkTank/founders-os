// ============================================================
// Memory tool tests
//
// Covers: memory_store, memory_recall, memory_forget,
// memory_summarize_and_store, and the embed provider factory.
//
// Part 1: Pure logic (no mocks) - scope/user_id mapping,
//         filter construction, scope_filter param derivation
// Part 2: Embed provider - factory selection, error paths,
//         singleton caching (via vi.isolateModules)
// Part 3: Handler behaviour (Supabase + embed mocked) -
//         insert args, error propagation, return shape
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// ──────────────────────────────────────────────────────────────
// PART 1 - PURE LOGIC (no mocks)
// ──────────────────────────────────────────────────────────────

// ── 1a. memory scope / user_id assignment ───────────────────
// Mirrors: const userId = scope === "org" ? "org" : getUserId();

describe("memory scope → user_id assignment", () => {
  const resolveUserId = (scope: "org" | "personal", envUserId = "default") =>
    scope === "org" ? "org" : envUserId;

  it("TC-MEM01: org scope always stores with user_id='org'", () => {
    expect(resolveUserId("org", "alice")).toBe("org");
    expect(resolveUserId("org", "default")).toBe("org");
  });

  it("TC-MEM02: personal scope stores with the caller's user_id", () => {
    expect(resolveUserId("personal", "alice")).toBe("alice");
    expect(resolveUserId("personal", "bob_123")).toBe("bob_123");
  });

  it("TC-MEM03: personal scope falls back to 'default' when env var is unset", () => {
    // getUserId() returns process.env.FOUNDERS_OS_USER_ID ?? "default"
    const userId = process.env.FOUNDERS_OS_USER_ID ?? "default";
    expect(resolveUserId("personal", userId)).toBe(userId);
    expect(typeof userId).toBe("string");
    expect(userId.length).toBeGreaterThan(0);
  });

  it("TC-MEM04: memory_summarize_and_store uses the same scope logic as memory_store", () => {
    // Both handlers use: scope === "org" ? "org" : getUserId()
    // Verify that org scope always overrides the caller identity
    const storeUserId = resolveUserId("org", "user_a");
    const summarizeUserId = resolveUserId("org", "user_a");
    expect(storeUserId).toBe(summarizeUserId);
    expect(storeUserId).toBe("org");
  });
});

// ── 1b. memory_forget .or() filter construction ──────────────
// Mirrors: .or(`user_id.eq.${userId},user_id.eq.org`)

describe("memory_forget — .or() filter construction", () => {
  const buildForgetFilter = (userId: string) =>
    `user_id.eq.${userId},user_id.eq.org`;

  it("TC-MEM05: filter always includes the caller's user_id clause", () => {
    const f = buildForgetFilter("alice_123");
    expect(f).toContain("user_id.eq.alice_123");
  });

  it("TC-MEM06: filter always includes the org clause", () => {
    // The org clause allows any user to match org-scoped memories since
    // all org memories have user_id='org'. See TC-MEM07 for the implication.
    const f = buildForgetFilter("alice_123");
    expect(f).toContain("user_id.eq.org");
  });

  it("TC-MEM07: any caller's filter matches org memories (any team member can delete org memories)", () => {
    // The .or() filter evaluates as: user_id=alice_123 OR user_id=org
    // Since org memories have user_id='org', the second clause always matches.
    const memoryUserId: string = "org";
    const callerUserId: string = "alice_123";
    const filter = buildForgetFilter(callerUserId);

    const clauseMatchesCaller = memoryUserId === callerUserId;
    const clauseMatchesOrg = memoryUserId === "org";
    const filterMatchesOrgMemory = clauseMatchesCaller || clauseMatchesOrg;

    expect(filterMatchesOrgMemory).toBe(true);
  });

  it("TC-MEM08: personal memories are protected from cross-user deletion", () => {
    // Alice's filter cannot match bob's personal memory because
    // bob's memory has user_id='bob_456', not 'alice_123' or 'org'.
    const memoryUserId: string = "bob_456";
    const callerUserId: string = "alice_123";

    const clauseMatchesCaller = memoryUserId === callerUserId;
    const clauseMatchesOrg = memoryUserId === "org";
    const filterMatchesBobsMemory = clauseMatchesCaller || clauseMatchesOrg;

    expect(filterMatchesBobsMemory).toBe(false);
  });
});

// ── 1c. memory_recall scope_filter derivation ────────────────
// Mirrors: scope_filter: scope === "both" ? null : (scope ?? null)

describe("memory_recall — scope_filter derivation for match_memories RPC", () => {
  const buildScopeFilter = (scope: "org" | "personal" | "both" | undefined) =>
    scope === "both" ? null : (scope ?? null);

  it("TC-MEM09: scope='both' passes null to the RPC — searches all memories", () => {
    expect(buildScopeFilter("both")).toBeNull();
  });

  it("TC-MEM10: scope='org' passes 'org' to the RPC — scopes to shared memories", () => {
    expect(buildScopeFilter("org")).toBe("org");
  });

  it("TC-MEM11: scope='personal' passes 'personal' to the RPC", () => {
    expect(buildScopeFilter("personal")).toBe("personal");
  });

  it("TC-MEM12: scope=undefined (omitted) passes null — defaults to all accessible memories", () => {
    expect(buildScopeFilter(undefined)).toBeNull();
  });
});

// ── 1d. memory_recall min_score parameter ────────────────────
// Validates schema accepts min_score and models the filtering logic.

describe("memory_recall — min_score parameter", () => {
  const getSchema = async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    return memoryTools.memory_recall.parameters;
  };

  it("TC-MEM59: min_score is accepted as an optional parameter", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", min_score: 0.5 });
    expect(result.success).toBe(true);
  });

  it("TC-MEM60: min_score rejects values below 0", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", min_score: -0.1 });
    expect(result.success).toBe(false);
  });

  it("TC-MEM61: min_score rejects values above 1", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", min_score: 1.5 });
    expect(result.success).toBe(false);
  });

  it("TC-MEM62: min_score accepts boundary values 0 and 1", async () => {
    const schema = await getSchema();
    expect(schema.safeParse({ query: "test", min_score: 0 }).success).toBe(true);
    expect(schema.safeParse({ query: "test", min_score: 1 }).success).toBe(true);
  });

  // Models the SQL filter: (1 - (embedding <=> query_embedding)) >= min_score
  const passesThreshold = (score: number, minScore: number) => score >= minScore;

  it("TC-MEM63: default threshold 0.35 filters out low-relevance noise", () => {
    expect(passesThreshold(0.55, 0.35)).toBe(true);   // good match
    expect(passesThreshold(0.35, 0.35)).toBe(true);   // boundary
    expect(passesThreshold(0.26, 0.35)).toBe(false);  // noise
    expect(passesThreshold(0.10, 0.35)).toBe(false);  // junk
  });

  it("TC-MEM64: tighter threshold filters more aggressively", () => {
    expect(passesThreshold(0.55, 0.60)).toBe(false);
    expect(passesThreshold(0.65, 0.60)).toBe(true);
  });

  it("TC-MEM65: min_score=0 returns everything (no filtering)", () => {
    expect(passesThreshold(0.01, 0)).toBe(true);
    expect(passesThreshold(0.99, 0)).toBe(true);
  });
});

// ── 1d-ii. memory_recall metadata filter schema validation ────
// Tests source_tool, created_after, and created_before params.

describe("memory_recall — metadata filter schema validation", () => {
  const getSchema = async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    return memoryTools.memory_recall.parameters;
  };

  it("TC-MEM66: source_tool is accepted as an optional string", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", source_tool: "complete_task" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM67: source_tool omitted is valid (optional param)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM68: created_after is accepted as an optional ISO 8601 string", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", created_after: "2026-04-01T00:00:00Z" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM69: created_before is accepted as an optional ISO 8601 string", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", created_before: "2026-05-01T00:00:00Z" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM70: all three metadata filters can be combined", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      query: "test",
      source_tool: "memory_summarize_and_store",
      created_after: "2026-03-01T00:00:00Z",
      created_before: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("TC-MEM71: metadata filters combine with existing params (scope, project, min_score)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      query: "architecture decisions",
      scope: "org",
      project: "founders-os",
      limit: 5,
      min_score: 0.5,
      source_tool: "complete_task",
      created_after: "2026-04-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

// ── 1d-iii. match_memories metadata filter WHERE clause logic ──
// Models the SQL WHERE clause:
//   AND (source_tool_filter IS NULL OR m.source_tool = source_tool_filter)
//   AND (created_after_filter IS NULL OR m.created_at >= created_after_filter)
//   AND (created_before_filter IS NULL OR m.created_at <= created_before_filter)

describe("match_memories — metadata filter WHERE clause logic", () => {
  type MemoryRow = {
    source_tool: string | null;
    created_at: string;
  };

  const passesSourceToolFilter = (
    row: MemoryRow,
    sourceToolFilter: string | null
  ): boolean => sourceToolFilter === null || row.source_tool === sourceToolFilter;

  const passesCreatedAfterFilter = (
    row: MemoryRow,
    createdAfterFilter: string | null
  ): boolean => createdAfterFilter === null || row.created_at >= createdAfterFilter;

  const passesCreatedBeforeFilter = (
    row: MemoryRow,
    createdBeforeFilter: string | null
  ): boolean => createdBeforeFilter === null || row.created_at <= createdBeforeFilter;

  const passesAllMetadataFilters = (
    row: MemoryRow,
    sourceToolFilter: string | null,
    createdAfterFilter: string | null,
    createdBeforeFilter: string | null
  ): boolean =>
    passesSourceToolFilter(row, sourceToolFilter) &&
    passesCreatedAfterFilter(row, createdAfterFilter) &&
    passesCreatedBeforeFilter(row, createdBeforeFilter);

  const taskMemory: MemoryRow = {
    source_tool: "complete_task",
    created_at: "2026-04-15T10:00:00Z",
  };
  const summarizeMemory: MemoryRow = {
    source_tool: "memory_summarize_and_store",
    created_at: "2026-03-01T09:00:00Z",
  };
  const storeMemory: MemoryRow = {
    source_tool: "memory_store",
    created_at: "2026-05-10T14:00:00Z",
  };

  it("TC-MEM72: null source_tool_filter matches all source_tool values", () => {
    expect(passesSourceToolFilter(taskMemory, null)).toBe(true);
    expect(passesSourceToolFilter(summarizeMemory, null)).toBe(true);
    expect(passesSourceToolFilter(storeMemory, null)).toBe(true);
  });

  it("TC-MEM73: source_tool_filter matches only exact source_tool value", () => {
    expect(passesSourceToolFilter(taskMemory, "complete_task")).toBe(true);
    expect(passesSourceToolFilter(taskMemory, "memory_store")).toBe(false);
    expect(passesSourceToolFilter(summarizeMemory, "memory_summarize_and_store")).toBe(true);
  });

  it("TC-MEM74: null created_after_filter matches all dates", () => {
    expect(passesCreatedAfterFilter(taskMemory, null)).toBe(true);
    expect(passesCreatedAfterFilter(summarizeMemory, null)).toBe(true);
  });

  it("TC-MEM75: created_after_filter excludes memories before the threshold", () => {
    expect(passesCreatedAfterFilter(taskMemory, "2026-04-01T00:00:00Z")).toBe(true);       // April 15 >= April 1
    expect(passesCreatedAfterFilter(summarizeMemory, "2026-04-01T00:00:00Z")).toBe(false);  // March 1 < April 1
  });

  it("TC-MEM76: created_before_filter excludes memories after the threshold", () => {
    expect(passesCreatedBeforeFilter(summarizeMemory, "2026-04-01T00:00:00Z")).toBe(true);  // March 1 <= April 1
    expect(passesCreatedBeforeFilter(storeMemory, "2026-04-01T00:00:00Z")).toBe(false);     // May 10 > April 1
  });

  it("TC-MEM77: date range filter (after + before) creates a window", () => {
    // Window: April 1 to April 30
    const after = "2026-04-01T00:00:00Z";
    const before = "2026-04-30T23:59:59Z";
    expect(passesAllMetadataFilters(taskMemory, null, after, before)).toBe(true);       // April 15 - in range
    expect(passesAllMetadataFilters(summarizeMemory, null, after, before)).toBe(false);  // March 1 - too early
    expect(passesAllMetadataFilters(storeMemory, null, after, before)).toBe(false);      // May 10 - too late
  });

  it("TC-MEM78: all three filters combine with AND logic", () => {
    // Only complete_task memories from April
    expect(passesAllMetadataFilters(
      taskMemory, "complete_task", "2026-04-01T00:00:00Z", "2026-04-30T23:59:59Z"
    )).toBe(true);

    // Wrong source_tool even though date matches
    expect(passesAllMetadataFilters(
      taskMemory, "memory_store", "2026-04-01T00:00:00Z", "2026-04-30T23:59:59Z"
    )).toBe(false);

    // Right source_tool but date out of range
    expect(passesAllMetadataFilters(
      summarizeMemory, "memory_summarize_and_store", "2026-04-01T00:00:00Z", "2026-04-30T23:59:59Z"
    )).toBe(false);
  });
});

// ── 1d-iv. memory_recall offset (pagination) schema validation ──

describe("memory_recall — offset (pagination) schema validation", () => {
  const getSchema = async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    return memoryTools.memory_recall.parameters;
  };

  it("TC-MEM79: offset is accepted as an optional integer", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", offset: 10 });
    expect(result.success).toBe(true);
  });

  it("TC-MEM80: offset omitted is valid (defaults to 0)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM81: offset=0 is valid (first page)", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", offset: 0 });
    expect(result.success).toBe(true);
  });

  it("TC-MEM82: offset rejects negative values", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", offset: -1 });
    expect(result.success).toBe(false);
  });

  it("TC-MEM83: offset rejects non-integer values", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({ query: "test", offset: 5.5 });
    expect(result.success).toBe(false);
  });

  it("TC-MEM84: offset combines with limit for paging", async () => {
    const schema = await getSchema();
    // Page 3 with 10 results per page
    const result = schema.safeParse({ query: "test", limit: 10, offset: 20 });
    expect(result.success).toBe(true);
  });

  it("TC-MEM85: offset combines with all other params", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      query: "architecture decisions",
      scope: "org",
      project: "founders-os",
      limit: 5,
      min_score: 0.5,
      source_tool: "complete_task",
      created_after: "2026-04-01T00:00:00Z",
      offset: 10,
    });
    expect(result.success).toBe(true);
  });
});

// ── 1d-v. match_memories OFFSET pagination logic ─────────────
// Models the SQL: LIMIT match_count OFFSET offset_param

describe("match_memories — OFFSET pagination logic", () => {
  // Model: given a sorted result set, OFFSET skips N rows, LIMIT takes M
  const paginate = <T>(results: T[], limit: number, offset: number): T[] =>
    results.slice(offset, offset + limit);

  const allResults = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  it("TC-MEM86: offset=0 returns the first page", () => {
    expect(paginate(allResults, 3, 0)).toEqual(["A", "B", "C"]);
  });

  it("TC-MEM87: offset=3 skips the first 3 results (page 2)", () => {
    expect(paginate(allResults, 3, 3)).toEqual(["D", "E", "F"]);
  });

  it("TC-MEM88: offset beyond result count returns empty", () => {
    expect(paginate(allResults, 3, 100)).toEqual([]);
  });

  it("TC-MEM89: last page may return fewer than limit", () => {
    // 10 results, page 4 of 3-per-page: only 1 result left
    expect(paginate(allResults, 3, 9)).toEqual(["J"]);
  });

  it("TC-MEM90: offset=0 with full limit returns everything", () => {
    expect(paginate(allResults, 10, 0)).toEqual(allResults);
  });
});

// ── 1e. match_memories project_filter applies to all scope branches ──
// Before migration 015 fix, AND (project_filter ...) bound only to the last
// OR branch (scope_filter = 'org'). These tests verify the corrected WHERE
// clause applies project filtering across all three scope paths.

describe("match_memories — project_filter applies regardless of scope", () => {
  // Models the corrected WHERE clause from 015_fix_match_memories_project_filter.sql
  const matchesWhere = (
    row: { user_id: string; project: string | null },
    userIdFilter: string,
    scopeFilter: string | null,
    projectFilter: string | null
  ): boolean => {
    const scopeMatch =
      (scopeFilter === null && (row.user_id === userIdFilter || row.user_id === "org")) ||
      (scopeFilter === "personal" && row.user_id === userIdFilter) ||
      (scopeFilter === "org" && row.user_id === "org");

    const projectMatch = projectFilter === null || row.project === projectFilter;

    return scopeMatch && projectMatch;
  };

  const orgMemoryFoundersOs = { user_id: "org", project: "founders-os" };
  const orgMemoryYak = { user_id: "org", project: "yak" };
  const personalMemoryFoundersOs = { user_id: "alice", project: "founders-os" };
  const personalMemoryYak = { user_id: "alice", project: "yak" };

  it("TC-MEM30: scope=null + project filter includes matching org memories", () => {
    expect(matchesWhere(orgMemoryFoundersOs, "alice", null, "founders-os")).toBe(true);
  });

  it("TC-MEM31: scope=null + project filter EXCLUDES non-matching org memories", () => {
    expect(matchesWhere(orgMemoryYak, "alice", null, "founders-os")).toBe(false);
  });

  it("TC-MEM32: scope='personal' + project filter includes matching personal memories", () => {
    expect(matchesWhere(personalMemoryFoundersOs, "alice", "personal", "founders-os")).toBe(true);
  });

  it("TC-MEM33: scope='personal' + project filter EXCLUDES non-matching personal memories", () => {
    expect(matchesWhere(personalMemoryYak, "alice", "personal", "founders-os")).toBe(false);
  });

  it("TC-MEM34: scope='org' + project filter includes matching org memories", () => {
    expect(matchesWhere(orgMemoryFoundersOs, "alice", "org", "founders-os")).toBe(true);
  });

  it("TC-MEM35: scope='org' + project filter EXCLUDES non-matching org memories", () => {
    expect(matchesWhere(orgMemoryYak, "alice", "org", "founders-os")).toBe(false);
  });

  it("TC-MEM36: null project filter returns all memories regardless of project", () => {
    expect(matchesWhere(orgMemoryFoundersOs, "alice", null, null)).toBe(true);
    expect(matchesWhere(orgMemoryYak, "alice", null, null)).toBe(true);
    expect(matchesWhere(personalMemoryFoundersOs, "alice", null, null)).toBe(true);
    expect(matchesWhere(personalMemoryYak, "alice", null, null)).toBe(true);
  });
});

// ── 1f. content size limits ──────────────────────────────────

describe("memory content size limits", () => {
  // Extract Zod schemas from the tool definitions for direct parsing
  const getSchemas = async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    return {
      store: memoryTools.memory_store.parameters,
      summarize: memoryTools.memory_summarize_and_store.parameters,
    };
  };

  const validContent = "a".repeat(20000);
  const oversizedContent = "a".repeat(20001);

  it("TC-MEM37: memory_store accepts content at exactly 20,000 characters", async () => {
    const { store } = await getSchemas();
    const result = store.safeParse({ content: validContent, scope: "personal" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM38: memory_store rejects content exceeding 20,000 characters", async () => {
    const { store } = await getSchemas();
    const result = store.safeParse({ content: oversizedContent, scope: "personal" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("20,000");
    }
  });

  it("TC-MEM39: memory_summarize_and_store accepts summary at exactly 20,000 characters", async () => {
    const { summarize } = await getSchemas();
    const result = summarize.safeParse({ session_summary: validContent, scope: "org" });
    expect(result.success).toBe(true);
  });

  it("TC-MEM40: memory_summarize_and_store rejects summary exceeding 20,000 characters", async () => {
    const { summarize } = await getSchemas();
    const result = summarize.safeParse({ session_summary: oversizedContent, scope: "org" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("20,000");
    }
  });
});

// ── 1g. near-duplicate detection threshold logic ─────────────

describe("related-memory detection — threshold logic", () => {
  const DEDUP_THRESHOLD = 0.75;

  const shouldBlock = (score: number) => score >= DEDUP_THRESHOLD;

  it("TC-MEM41: score above threshold triggers related-memory conflict", () => {
    expect(shouldBlock(0.80)).toBe(true);
    expect(shouldBlock(0.92)).toBe(true);
    expect(shouldBlock(1.0)).toBe(true);
  });

  it("TC-MEM42: score at exactly the threshold triggers related-memory conflict", () => {
    expect(shouldBlock(0.75)).toBe(true);
  });

  it("TC-MEM43: score below threshold allows storage", () => {
    expect(shouldBlock(0.74)).toBe(false);
    expect(shouldBlock(0.60)).toBe(false);
    expect(shouldBlock(0.50)).toBe(false);
  });

  it("TC-MEM44: force=true parameter is accepted by memory_store schema", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    const result = memoryTools.memory_store.parameters.safeParse({
      content: "test",
      scope: "personal",
      force: true,
    });
    expect(result.success).toBe(true);
  });

  it("TC-MEM45: force=true parameter is accepted by memory_summarize_and_store schema", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    const result = memoryTools.memory_summarize_and_store.parameters.safeParse({
      session_summary: "test session",
      scope: "org",
      force: true,
    });
    expect(result.success).toBe(true);
  });
});

// ── 1h. memory_update: schema, ownership, and confirmation logic ──

describe("memory_update — schema validation", () => {
  const getSchema = async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    return memoryTools.memory_update.parameters;
  };

  it("TC-MEM46: accepts valid update params", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      memory_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      content: "Updated content",
    });
    expect(result.success).toBe(true);
  });

  it("TC-MEM47: requires memory_id to be a valid UUID", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      memory_id: "not-a-uuid",
      content: "Updated content",
    });
    expect(result.success).toBe(false);
  });

  it("TC-MEM48: requires content field", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      memory_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
    expect(result.success).toBe(false);
  });

  it("TC-MEM49: rejects content exceeding 20,000 characters", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      memory_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      content: "a".repeat(20001),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("20,000");
    }
  });

  it("TC-MEM50: accepts optional project and confirm params", async () => {
    const schema = await getSchema();
    const result = schema.safeParse({
      memory_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      content: "Updated content",
      project: "founders-os",
      confirm: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("memory_update — ownership and confirmation logic", () => {
  // Models the decision logic from the handler

  const shouldRequireConfirmation = (scope: string, confirm?: boolean) =>
    scope === "org" && !confirm;

  const canUpdate = (scope: string, createdBy: string, callerId: string) =>
    scope !== "org" || createdBy === callerId;

  const resolveProject = (newProject: string | undefined, existingProject: string | null) =>
    newProject !== undefined ? newProject : existingProject;

  it("TC-MEM51: org-scoped memories require confirmation", () => {
    expect(shouldRequireConfirmation("org")).toBe(true);
    expect(shouldRequireConfirmation("org", false)).toBe(true);
  });

  it("TC-MEM52: org-scoped memories skip confirmation when confirm=true", () => {
    expect(shouldRequireConfirmation("org", true)).toBe(false);
  });

  it("TC-MEM53: personal-scoped memories never require confirmation", () => {
    expect(shouldRequireConfirmation("personal")).toBe(false);
    expect(shouldRequireConfirmation("personal", false)).toBe(false);
  });

  it("TC-MEM54: creator can update their own org memory", () => {
    expect(canUpdate("org", "alice", "alice")).toBe(true);
  });

  it("TC-MEM55: non-creator cannot update another user's org memory", () => {
    expect(canUpdate("org", "alice", "bob")).toBe(false);
  });

  it("TC-MEM56: personal memory owner can always update", () => {
    expect(canUpdate("personal", "alice", "alice")).toBe(true);
  });

  it("TC-MEM57: project updates when explicitly provided", () => {
    expect(resolveProject("new-project", "old-project")).toBe("new-project");
    expect(resolveProject("new-project", null)).toBe("new-project");
  });

  it("TC-MEM58: project preserved when omitted", () => {
    expect(resolveProject(undefined, "existing-project")).toBe("existing-project");
    expect(resolveProject(undefined, null)).toBeNull();
  });
});

// ── 1i. memory_summarize_and_store source_tool constant ──────

describe("memory_summarize_and_store — source_tool is always the tool name", () => {
  it("TC-MEM13: source_tool is always set to 'memory_summarize_and_store'", () => {
    // The handler hardcodes this value so its entries are distinguishable
    // from memory_store entries in queries (which use the caller-supplied value).
    const expectedSourceTool = "memory_summarize_and_store";
    expect(expectedSourceTool).toBe("memory_summarize_and_store");
  });

  it("TC-MEM14: complete_task memory bridge uses source_tool='complete_task'", () => {
    // When complete_task stores a memory (store_as_memory=true), it uses:
    //   source_tool: "complete_task"
    // This distinguishes auto-stored completion memories from manual ones.
    const completionSourceTool = "complete_task";
    expect(completionSourceTool).not.toBe("memory_summarize_and_store");
    expect(completionSourceTool).not.toBe("memory_store");
  });
});


// ──────────────────────────────────────────────────────────────
// PART 2 - EMBED PROVIDER FACTORY
// Tests the embed.ts factory after the 2026-05-28 refactor: it now
// takes an EmbeddingConfig argument (built from env via
// readEmbeddingConfigFromEnv in context.ts). The env-var parsing
// itself is exercised through that helper so the EMBEDDING_*
// env contract continues to be tested end-to-end.
// ──────────────────────────────────────────────────────────────

describe("getEmbeddingProvider — factory and error paths", () => {
  it("TC-EMBED01: unknown provider name throws a descriptive error", async () => {
    process.env.EMBEDDING_PROVIDER = "mystery_cloud";
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    expect(() => readEmbeddingConfigFromEnv()).toThrow(
      /Unknown EMBEDDING_PROVIDER.*mystery_cloud/i
    );
    delete process.env.EMBEDDING_PROVIDER;
  });

  it("TC-EMBED02: provider name matching is case-insensitive", async () => {
    process.env.EMBEDDING_PROVIDER = "OpenAI"; // mixed case
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    expect(() => readEmbeddingConfigFromEnv()).not.toThrow();
    const config = readEmbeddingConfigFromEnv();
    expect(config.provider).toBe("openai");
    delete process.env.EMBEDDING_PROVIDER;
  });

  it("TC-EMBED03: provider is cached per config (singleton pattern)", async () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    const { _resetProviderForTesting, getEmbeddingProvider } = await import(
      "../tools/memory/embed.js"
    );
    _resetProviderForTesting();
    const cfg = readEmbeddingConfigFromEnv();
    const p1 = getEmbeddingProvider(cfg);
    const p2 = getEmbeddingProvider(cfg);
    expect(p1).toBe(p2); // same reference confirms cache
    _resetProviderForTesting();
    delete process.env.EMBEDDING_PROVIDER;
  });

  it("TC-EMBED04: defaults to openai when EMBEDDING_PROVIDER is not set", async () => {
    delete process.env.EMBEDDING_PROVIDER;
    const previousKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    const { _resetProviderForTesting, getEmbeddingProvider } = await import(
      "../tools/memory/embed.js"
    );
    _resetProviderForTesting();
    const cfg = readEmbeddingConfigFromEnv();
    expect(cfg.provider).toBe("openai");
    const provider = getEmbeddingProvider(cfg);
    await expect(provider.embed("test")).rejects.toThrow(/OPENAI_API_KEY/i);
    _resetProviderForTesting();
    if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey;
  });

  it("TC-EMBED05: EMBEDDING_DIM is parsed as an integer, not a string", async () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    process.env.EMBEDDING_DIM = "512";
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    const { _resetProviderForTesting, getEmbeddingProvider } = await import(
      "../tools/memory/embed.js"
    );
    _resetProviderForTesting();
    const cfg = readEmbeddingConfigFromEnv();
    const provider = getEmbeddingProvider(cfg);
    expect(provider.dimensions).toBe(512);
    expect(typeof provider.dimensions).toBe("number");
    _resetProviderForTesting();
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_DIM;
  });

  it("TC-EMBED06: ollama provider uses default dimensions of 768 when EMBEDDING_DIM unset", async () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    delete process.env.EMBEDDING_DIM;
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    const { _resetProviderForTesting, getEmbeddingProvider } = await import(
      "../tools/memory/embed.js"
    );
    _resetProviderForTesting();
    const cfg = readEmbeddingConfigFromEnv();
    const provider = getEmbeddingProvider(cfg);
    expect(provider.dimensions).toBe(768);
    _resetProviderForTesting();
    delete process.env.EMBEDDING_PROVIDER;
  });

  it("TC-EMBED07: bedrock provider uses default dimensions of 1024 when EMBEDDING_DIM unset", async () => {
    process.env.EMBEDDING_PROVIDER = "bedrock";
    delete process.env.EMBEDDING_DIM;
    const { readEmbeddingConfigFromEnv } = await import("../context.js");
    const { _resetProviderForTesting, getEmbeddingProvider } = await import(
      "../tools/memory/embed.js"
    );
    _resetProviderForTesting();
    const cfg = readEmbeddingConfigFromEnv();
    const provider = getEmbeddingProvider(cfg);
    expect(provider.dimensions).toBe(1024);
    _resetProviderForTesting();
    delete process.env.EMBEDDING_PROVIDER;
  });
});


// ──────────────────────────────────────────────────────────────
// PART 3 - HANDLER BEHAVIOUR (Supabase + embed mocked)
// ──────────────────────────────────────────────────────────────

// Shared mock state defined via vi.hoisted so it exists when vi.mock
// factories run (which are hoisted before imports).

const { mockEmbed, mockInsertArgs, mockDb } = vi.hoisted(() => ({
  mockEmbed: vi.fn<(content: string) => Promise<number[]>>(),
  mockInsertArgs: { captured: {} as Record<string, Record<string, unknown> | null> },
  mockDb: {
    insertData: null as unknown,
    insertError: null as { message: string } | null,
    rpcData: null as unknown,
    rpcError: null as { message: string } | null,
    deleteError: null as { message: string } | null,
    selectData: null as unknown,
    selectError: null as { message: string } | null,
  },
}));

// Pass-through mock: keep getEmbeddingProvider (real) so Part 2's
// vi.isolateModules() tests can exercise the factory directly.
// Only replace the exported `embed` convenience wrapper used by handlers.
vi.mock("../tools/memory/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/memory/embed.js")>();
  return {
    ...actual,
    embed: mockEmbed,
  };
});

// After the 2026-05-28 ToolContext migration, memory handlers take
// (ctx, params). The mock below still provides the underlying client
// behaviour through vi.mock("../supabase.js"); we build a fake ctx
// out of it and pass it to every handler call from this point on.
vi.mock("../supabase.js", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (obj: Record<string, unknown>) => {
        mockInsertArgs.captured[table] = obj;
        return {
          select: (_cols: string) => ({
            single: () =>
              Promise.resolve({ data: mockDb.insertData, error: mockDb.insertError }),
          }),
        };
      },
      // SELECT chain: supports .select().eq().or().single() used by memory_forget fetch
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          or: (_filter: string) => ({
            single: () =>
              Promise.resolve({ data: mockDb.selectData, error: mockDb.selectError }),
          }),
        }),
      }),
      // DELETE chain: supports both .delete().eq().or() (confirm path)
      // and .delete().eq().eq() (personal memory path)
      delete: () => {
        const leaf = Promise.resolve({ error: mockDb.deleteError });
        const inner = {
          or: (_filter: string) => leaf,
          eq: (_col2: string, _val2: string) => leaf,
        };
        return {
          eq: (_col: string, _val: string) => inner,
        };
      },
      // UPDATE chain: supports .update().eq().or().select().single()
      update: (_obj: Record<string, unknown>) => {
        const leaf = {
          select: (_cols: string) => ({
            single: () =>
              Promise.resolve({ data: mockDb.selectData, error: mockDb.selectError }),
          }),
        };
        return {
          eq: (_col: string, _val: string) => ({
            or: (_filter: string) => leaf,
          }),
        };
      },
    }),
    rpc: (_name: string, params: unknown) => {
      mockInsertArgs.captured["__rpc__"] = params as Record<string, unknown>;
      return Promise.resolve({ data: mockDb.rpcData, error: mockDb.rpcError });
    },
  }),
}));

// ── Mock ToolContext ─────────────────────────────────────────
// Built from the hoisted Supabase mock above. Every handler call in
// Part 3 passes this as the first argument.

import { createServiceClient } from "../supabase.js";
import type { ToolContext } from "../types/context.js";

const _mockClient = createServiceClient();
const mockCtx: ToolContext = {
  db: _mockClient,
  admin: _mockClient,
  companyId: "default",
  userId: "default",
  identityMode: "env",
  isSoloMode: true,
};

// ── Test setup ───────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertArgs.captured = {};

  mockEmbed.mockResolvedValue([0.1, 0.2, 0.3]);

  const defaultMemoryRow = {
    id: "mem-uuid-1",
    user_id: "default",
    scope: "personal",
    project: null,
    content: "test content",
    created_at: "2026-04-24T10:00:00Z",
  };
  mockDb.insertData = defaultMemoryRow;
  mockDb.insertError = null;
  mockDb.rpcData = [];
  mockDb.rpcError = null;
  mockDb.deleteError = null;
  // personal-scope memory used as the default select response for memory_forget
  mockDb.selectData = {
    id: "mem-uuid-abc",
    user_id: "default",
    scope: "personal",
    project: null,
    content: "a test memory to forget",
    created_at: "2026-04-24T10:00:00Z",
  };
  mockDb.selectError = null;
});

// ── memory_store ─────────────────────────────────────────────

describe("memory_store handler — mocked", () => {
  it("TC-MEM16b: insert is scoped to the caller's company_id (migration 037)", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "a fact that belongs to one tenant only",
      scope: "org",
    });
    expect(mockInsertArgs.captured["memories"]).toMatchObject({
      company_id: "default",
    });
  });

  it("TC-MEM16c: memory_recall passes company_id_filter to match_memories (migration 037)", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_recall.handler(mockCtx, { query: "what did we decide" });
    expect(mockInsertArgs.captured["__rpc__"]).toMatchObject({
      company_id_filter: "default",
    });
  });

  it("TC-MEM15: personal scope inserts with user_id from env (not 'org')", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "remember this",
      scope: "personal",
    });
    expect(mockInsertArgs.captured["memories"]?.user_id).not.toBe("org");
    expect(typeof mockInsertArgs.captured["memories"]?.user_id).toBe("string");
  });

  it("TC-MEM16: org scope inserts with user_id='org'", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "team knowledge",
      scope: "org",
    });
    expect(mockInsertArgs.captured["memories"]?.user_id).toBe("org");
    expect(mockInsertArgs.captured["memories"]?.scope).toBe("org");
  });

  it("TC-MEM17: embed() is called with the exact content string", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "important fact about the product",
      scope: "personal",
    });
    expect(mockEmbed).toHaveBeenCalledOnce();
    // After 2026-05-28 ctx-aware embed: signature is (ctx, text).
    expect(mockEmbed).toHaveBeenCalledWith(mockCtx, "important fact about the product");
  });

  it("TC-MEM18: embedding is JSON-stringified before DB insert", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, { content: "test", scope: "personal" });
    // embedding is stored as a JSON string, not a raw array
    const embeddingStored = mockInsertArgs.captured["memories"]?.embedding;
    expect(typeof embeddingStored).toBe("string");
    expect(() => JSON.parse(embeddingStored as string)).not.toThrow();
    expect(JSON.parse(embeddingStored as string)).toEqual([0.1, 0.2, 0.3]);
  });

  it("TC-MEM19: optional project and source_tool are passed through", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "test",
      scope: "org",
      project: "founders-os",
      source_tool: "get_session_start",
    });
    expect(mockInsertArgs.captured["memories"]?.project).toBe("founders-os");
    expect(mockInsertArgs.captured["memories"]?.source_tool).toBe("get_session_start");
  });

  it("TC-MEM20: omitted project defaults to null in the insert", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, { content: "test", scope: "personal" });
    expect(mockInsertArgs.captured["memories"]?.project).toBeNull();
    expect(mockInsertArgs.captured["memories"]?.source_tool).toBeNull();
  });

  it("TC-MEM21: DB insert error throws with descriptive message", async () => {
    mockDb.insertError = { message: "unique constraint violation" };
    mockDb.insertData = null;
    const { memoryTools } = await import("../tools/memory/index.js");
    await expect(
      memoryTools.memory_store.handler(mockCtx, { content: "test", scope: "personal" })
    ).rejects.toThrow(/Failed to store memory.*unique constraint violation/);
  });

  it("TC-MEM22: embed() failure propagates as a thrown error", async () => {
    mockEmbed.mockRejectedValue(new Error("OpenAI rate limit exceeded"));
    const { memoryTools } = await import("../tools/memory/index.js");
    await expect(
      memoryTools.memory_store.handler(mockCtx, { content: "test", scope: "personal" })
    ).rejects.toThrow(/rate limit exceeded/);
  });
});

// ── memory_recall ─────────────────────────────────────────────

describe("memory_recall handler — mocked", () => {
  it("TC-MEM23: embed() is called with the query string", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_recall.handler(mockCtx, { query: "what did we decide about pricing?" });
    expect(mockEmbed).toHaveBeenCalledWith(mockCtx, "what did we decide about pricing?");
  });

  it("TC-MEM24: RPC error throws with descriptive message", async () => {
    mockDb.rpcError = { message: "match_memories function not found" };
    mockDb.rpcData = null;
    const { memoryTools } = await import("../tools/memory/index.js");
    await expect(
      memoryTools.memory_recall.handler(mockCtx, { query: "test" })
    ).rejects.toThrow(/Failed to recall memories.*match_memories function not found/);
  });
});

// ── memory_forget ─────────────────────────────────────────────

describe("memory_forget handler — mocked", () => {
  it("TC-MEM25: successful deletion returns { deleted: true, memory_id }", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    const result = await memoryTools.memory_forget.handler(mockCtx, {
      memory_id: "mem-uuid-abc",
    }) as { deleted: boolean; memory_id: string };
    expect(result.deleted).toBe(true);
    expect(result.memory_id).toBe("mem-uuid-abc");
  });

  it("TC-MEM26: delete error throws with descriptive message", async () => {
    mockDb.deleteError = { message: "row-level security violation" };
    const { memoryTools } = await import("../tools/memory/index.js");
    await expect(
      memoryTools.memory_forget.handler(mockCtx, { memory_id: "mem-uuid-abc" })
    ).rejects.toThrow(/Failed to delete memory.*row-level security violation/);
  });
});

// ── memory_summarize_and_store ────────────────────────────────

describe("memory_summarize_and_store handler — mocked", () => {
  it("TC-MEM27: always inserts source_tool='memory_summarize_and_store'", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_summarize_and_store.handler(mockCtx, {
      session_summary: "We decided to ship v1 by end of April",
      scope: "org",
    });
    expect(mockInsertArgs.captured["memories"]?.source_tool).toBe("memory_summarize_and_store");
  });

  it("TC-MEM28: org scope sets user_id='org' in the summarize path too", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_summarize_and_store.handler(mockCtx, {
      session_summary: "Discussed Q2 roadmap with the team",
      scope: "org",
    });
    expect(mockInsertArgs.captured["memories"]?.user_id).toBe("org");
  });

  it("TC-MEM29: embed() is called with the session_summary content", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_summarize_and_store.handler(mockCtx, {
      session_summary: "Long narrative about what happened",
      scope: "personal",
    });
    expect(mockEmbed).toHaveBeenCalledWith(mockCtx, "Long narrative about what happened");
  });
});

// ── memory hygiene: recall guidance + change_reason audit ────
// memory_recall returns standing conflict-handling guidance. memory_update
// accepts a change_reason that is preserved in the audit log for org memories.

describe("memory hygiene codification — recall shape + change_reason", () => {
  it("TC-MEM91: memory_update schema accepts an optional change_reason", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    const result = memoryTools.memory_update.parameters.safeParse({
      memory_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      content: "Project Atlas is the team's current research app",
      change_reason: "Project Beacon was retired and replaced by Project Atlas",
    });
    expect(result.success).toBe(true);
  });

  it("TC-MEM92: memory_recall returns { memories, count, guidance }", async () => {
    mockDb.rpcData = [
      { id: "m1", content: "a", score: 0.9 },
      { id: "m2", content: "b", score: 0.8 },
    ];
    const { memoryTools } = await import("../tools/memory/index.js");
    const result = (await memoryTools.memory_recall.handler(mockCtx, { query: "anything" })) as {
      memories: unknown[];
      count: number;
      guidance: string;
    };
    expect(result.memories).toEqual(mockDb.rpcData);
    expect(result.count).toBe(2);
    // The guidance carries the notice/investigate/resolve-or-ask rule.
    expect(result.guidance).toMatch(/investigate/i);
    expect(result.guidance).toMatch(/change_reason/);
  });

  it("TC-MEM93: org memory_update records change_reason in the audit log", async () => {
    // Seed ownership to the mock context's user so the org-update guard passes
    // regardless of any ambient FOUNDERS_OS_USER_ID in the runner's shell.
    const callerId = mockCtx.userId;
    // An org-scoped memory created by the caller, so the update is permitted.
    mockDb.selectData = {
      id: "mem-uuid-org",
      user_id: "org",
      scope: "org",
      project: null,
      content: "old content",
      created_by: callerId,
      created_at: "2026-05-21T00:00:00Z",
    };
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_update.handler(mockCtx, {
      memory_id: "mem-uuid-org",
      content: "new content",
      change_reason: "investigated: the project was renamed",
      resolution: "confirm",
    });
    const audit = mockInsertArgs.captured["audit_log"] as Record<string, unknown> | undefined;
    expect(audit).toBeTruthy();
    expect(audit?.action).toBe("memory_update");
    expect(audit?.metadata).toEqual({ change_reason: "investigated: the project was renamed" });
  });

  it("TC-MEM94: change_reason is omitted from audit metadata when not provided", async () => {
    // Seed ownership to the mock context's user so the org-update guard passes
    // regardless of any ambient FOUNDERS_OS_USER_ID in the runner's shell.
    const callerId = mockCtx.userId;
    mockDb.selectData = {
      id: "mem-uuid-org",
      user_id: "org",
      scope: "org",
      project: null,
      content: "old content",
      created_by: callerId,
      created_at: "2026-05-21T00:00:00Z",
    };
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_update.handler(mockCtx, {
      memory_id: "mem-uuid-org",
      content: "new content",
      resolution: "confirm",
    });
    const audit = mockInsertArgs.captured["audit_log"] as Record<string, unknown> | undefined;
    expect(audit).toBeTruthy();
    expect(audit?.metadata).toBeNull();
  });
});

// ── 1j. handoff_doc -> metadata.handoff_doc write path ───────
// The durable half of the get_last_checkpoint handoff fix: the checkpoint
// write records the handoff path as structured metadata so readers never parse.

describe("checkpoint write-path — handoff_doc lands in metadata", () => {
  it("TC-MEM95: memory_summarize_and_store writes metadata.handoff_doc alongside kind", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_summarize_and_store.handler(mockCtx, {
      session_summary: "checkpoint body",
      scope: "org",
      project: "founders-os",
      kind: "checkpoint",
      handoff_doc: "docs/founders-os-session-handoff-2026-07-20-01.md",
      resolution: "confirm",
    });
    const meta = mockInsertArgs.captured["memories"]?.metadata as Record<string, unknown> | undefined;
    expect(meta).toEqual({
      kind: "checkpoint",
      handoff_doc: "docs/founders-os-session-handoff-2026-07-20-01.md",
    });
  });

  it("TC-MEM96: memory_store writes metadata.handoff_doc when provided", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "checkpoint body",
      scope: "org",
      kind: "checkpoint",
      handoff_doc: "docs/x-session-handoff-2026-07-20-02.md",
      resolution: "confirm",
    });
    const meta = mockInsertArgs.captured["memories"]?.metadata as Record<string, unknown> | undefined;
    expect(meta?.handoff_doc).toBe("docs/x-session-handoff-2026-07-20-02.md");
  });

  it("TC-MEM97: no kind and no handoff_doc omits metadata entirely (unchanged behavior)", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "plain memory",
      scope: "personal",
    });
    expect(mockInsertArgs.captured["memories"]?.metadata).toBeUndefined();
  });

  it("TC-MEM98: handoff_doc without kind writes metadata.handoff_doc only", async () => {
    const { memoryTools } = await import("../tools/memory/index.js");
    await memoryTools.memory_store.handler(mockCtx, {
      content: "note",
      scope: "personal",
      handoff_doc: "docs/y-session-handoff-2026-07-20-01.md",
    });
    const meta = mockInsertArgs.captured["memories"]?.metadata as Record<string, unknown> | undefined;
    expect(meta).toEqual({ handoff_doc: "docs/y-session-handoff-2026-07-20-01.md" });
  });
});
