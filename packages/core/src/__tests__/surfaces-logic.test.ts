// ============================================================
// Tests for surfaces tool logic: get_weekly_retro week boundary
// calculation, get_session_start MTD logic, get_stuck_list
// days_stale deduplication, and RSS signal parsing.
// No real DB required. Pure logic tests.
// ============================================================
import { describe, it, expect, vi } from "vitest";

// ── get_weekly_retro: Monday boundary calculation ────────────────────────────
// Mirrors the week-boundary logic in surfaces/index.ts get_weekly_retro handler.

describe("get_weekly_retro — week boundary calculation", () => {
  /**
   * Replicate the handler logic:
   *   dayOfWeek = now.getDay()   (0=Sun, 1=Mon … 6=Sat)
   *   mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
   */
  const getWeekBounds = (now: Date, weekOffset = 0) => {
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + mondayOffset);
    thisMonday.setHours(0, 0, 0, 0);

    const weekStart = new Date(thisMonday);
    weekStart.setDate(thisMonday.getDate() - weekOffset * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    return { weekStart, weekEnd };
  };

  it("TC-SUR01: on a Wednesday, week starts on the preceding Monday", () => {
    // 2025-03-12 is a Wednesday
    const now = new Date("2025-03-12T10:00:00Z");
    const { weekStart } = getWeekBounds(now);
    expect(weekStart.toISOString().split("T")[0]).toBe("2025-03-10"); // Monday
  });

  it("TC-SUR02: on a Monday, week starts on that same Monday", () => {
    // 2025-03-10 is a Monday
    const now = new Date("2025-03-10T09:00:00Z");
    const { weekStart } = getWeekBounds(now);
    expect(weekStart.toISOString().split("T")[0]).toBe("2025-03-10");
  });

  it("TC-SUR03: on a Sunday, week starts on the preceding Monday (6 days back)", () => {
    // 2025-03-16 is a Sunday
    const now = new Date("2025-03-16T15:00:00Z");
    const { weekStart } = getWeekBounds(now);
    expect(weekStart.toISOString().split("T")[0]).toBe("2025-03-10");
  });

  it("TC-SUR04: weekOffset=1 moves the window back by exactly 7 days", () => {
    // On 2025-03-12 (Wed), current week starts 2025-03-10
    // Previous week (offset=1) should start 2025-03-03
    const now = new Date("2025-03-12T10:00:00Z");
    const { weekStart } = getWeekBounds(now, 1);
    expect(weekStart.toISOString().split("T")[0]).toBe("2025-03-03");
  });

  it("TC-SUR05: weekEnd is exactly 7 days after weekStart", () => {
    const now = new Date("2025-03-12T10:00:00Z");
    const { weekStart, weekEnd } = getWeekBounds(now);
    const diffMs = weekEnd.getTime() - weekStart.getTime();
    expect(diffMs).toBe(7 * 86_400_000);
  });

  it("TC-SUR06: week label uses ISO date strings sliced at T", () => {
    const now = new Date("2025-03-12T10:00:00Z");
    const { weekStart, weekEnd } = getWeekBounds(now);
    // weekLabel in handler: weekStart.toISOString().split("T")[0] + " to " + new Date(weekEnd - 86400000).split("T")[0]
    const label =
      weekStart.toISOString().split("T")[0] +
      " to " +
      new Date(weekEnd.getTime() - 86_400_000).toISOString().split("T")[0];
    expect(label).toBe("2025-03-10 to 2025-03-16");
  });
});

// ── get_session_start: MTD date calculation ──────────────────────────────────

describe("get_session_start — MTD start date", () => {
  // Mirrors: const monthStart = today.slice(0, 7) + "-01";
  const getMtdStart = (today: string) => today.slice(0, 7) + "-01";

  it("TC-SUR07: MTD start is the first of the current month", () => {
    expect(getMtdStart("2025-03-15")).toBe("2025-03-01");
  });

  it("TC-SUR08: MTD start is correct on the last day of a month", () => {
    expect(getMtdStart("2025-01-31")).toBe("2025-01-01");
  });

  it("TC-SUR09: MTD start for December produces the correct year-month", () => {
    expect(getMtdStart("2025-12-05")).toBe("2025-12-01");
  });

  it("TC-SUR10: MTD start is always a YYYY-MM-01 pattern", () => {
    const date = "2026-07-22";
    const mtd = getMtdStart(date);
    expect(mtd).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

// ── get_stuck_list: deduplication logic ─────────────────────────────────────

describe("get_stuck_list — deduplication across categories", () => {
  // Mirrors the seen set used in the handler to avoid double-counting
  const dedup = (
    items: Array<{ id: string; category: string }>
  ): Array<{ id: string; category: string }> => {
    const seen = new Set<string>();
    const result: Array<{ id: string; category: string }> = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      result.push(item);
    }
    return result;
  };

  it("TC-SUR11: a task appearing in both blocked and overdue lists is deduplicated", () => {
    const combined = [
      { id: "task-1", category: "blocked" },
      { id: "task-2", category: "overdue" },
      { id: "task-1", category: "overdue" }, // duplicate
    ];
    const result = dedup(combined);
    expect(result).toHaveLength(2);
    // The first occurrence (blocked) is kept, overdue duplicate dropped
    expect(result[0].category).toBe("blocked");
  });

  it("TC-SUR12: no duplicates in input → all items preserved", () => {
    const items = [
      { id: "a", category: "stale" },
      { id: "b", category: "blocked" },
      { id: "c", category: "overdue" },
    ];
    expect(dedup(items)).toHaveLength(3);
  });

  it("TC-SUR13: empty input produces empty output", () => {
    expect(dedup([])).toHaveLength(0);
  });
});

// ── get_stuck_list: suggested action message generation ──────────────────────

describe("get_stuck_list — suggested action messages", () => {
  // Mirrors the action-message logic in the stale_in_progress branch
  const buildStaleAction = (assignedTo: string | null): string =>
    assignedTo
      ? `Check in with ${assignedTo} or add a progress note`
      : "Assign to someone or add a progress note";

  it("TC-SUR14: assigned task → check-in message names the assignee", () => {
    const msg = buildStaleAction("@claude");
    expect(msg).toContain("@claude");
    expect(msg).toContain("Check in");
  });

  it("TC-SUR15: unassigned task → generic assign message", () => {
    const msg = buildStaleAction(null);
    expect(msg).toContain("Assign to someone");
  });

  // Mirrors the blocked task action logic
  const buildBlockedAction = (
    blockedByTaskId: string | null,
    blockedReason: string | null
  ): string => {
    if (blockedByTaskId) return "Resolve blocking task or clear the dependency";
    if (blockedReason) return `Address blocker: ${blockedReason}`;
    return "Add a blocked_reason or resolve the blocker";
  };

  it("TC-SUR16: blocked by dependency → references the dependency", () => {
    const msg = buildBlockedAction("some-uuid", null);
    expect(msg).toContain("dependency");
  });

  it("TC-SUR17: blocked with reason but no dependency → surfaces the reason", () => {
    const msg = buildBlockedAction(null, "Waiting for API access");
    expect(msg).toContain("Waiting for API access");
  });

  it("TC-SUR18: blocked with neither dependency nor reason → prompts to add reason", () => {
    const msg = buildBlockedAction(null, null);
    expect(msg).toContain("Add a blocked_reason");
  });
});

// ── get_weekly_retro: LinkedIn draft format ──────────────────────────────────

describe("get_weekly_retro — LinkedIn draft generation", () => {
  type RetroTask = {
    title: string;
    completed_at: string;
    assigned_to: string | null;
    notes: string[];
  };

  const buildLinkedinDraft = (groups: Record<string, { tasks: RetroTask[] }>): string => {
    let draft = `This week in the build:\n\n`;
    for (const [tag, group] of Object.entries(groups)) {
      const label = tag === "ungrouped" ? "General" : tag;
      draft += `${label}\n`;
      for (const t of group.tasks) {
        draft += `- ${t.title}`;
        if (t.notes.length > 0) draft += ` -- "${t.notes[0]}"`;
        draft += `\n`;
      }
      draft += `\n`;
    }
    draft += `#buildinpublic #founders`;
    return draft;
  };

  it("TC-SUR19: draft starts with 'This week in the build'", () => {
    const draft = buildLinkedinDraft({});
    expect(draft).toContain("This week in the build");
  });

  it("TC-SUR20: 'ungrouped' tag renders as 'General'", () => {
    const draft = buildLinkedinDraft({
      ungrouped: { tasks: [{ title: "Fix thing", completed_at: "", assigned_to: null, notes: [] }] },
    });
    expect(draft).toContain("General");
    expect(draft).not.toContain("ungrouped");
  });

  it("TC-SUR21: task with a completion note includes the note as a quote", () => {
    const draft = buildLinkedinDraft({
      "#founders-os": {
        tasks: [
          {
            title: "Ship v0.5",
            completed_at: "",
            assigned_to: null,
            notes: ["Took 3 iterations but finally got it right"],
          },
        ],
      },
    });
    expect(draft).toContain('"Took 3 iterations but finally got it right"');
  });

  it("TC-SUR22: task without completion notes has no quote marker", () => {
    const draft = buildLinkedinDraft({
      "#founders-os": {
        tasks: [
          { title: "Update docs", completed_at: "", assigned_to: null, notes: [] },
        ],
      },
    });
    expect(draft).not.toContain(' -- "');
  });

  it("TC-SUR23: draft always ends with hashtags", () => {
    const draft = buildLinkedinDraft({});
    expect(draft.endsWith("#buildinpublic #founders")).toBe(true);
  });
});

// ── RSS signal: unread count parsing ────────────────────────────────────────
// Mirrors getRssSignal logic in surfaces/index.ts

describe("getRssSignal — unread count logic", () => {
  type FeedItem = { is_read?: boolean; feed_id: number };
  type Feed = { id: number; category?: string };

  const computeRssSignal = (items: FeedItem[], feeds: Feed[]) => {
    const feedCategoryMap = new Map<number, string>();
    for (const feed of feeds) {
      feedCategoryMap.set(feed.id, feed.category ?? "other");
    }
    const byCategory: Record<string, number> = {};
    let totalUnread = 0;
    for (const item of items) {
      if (!item.is_read) {
        totalUnread++;
        const cat = feedCategoryMap.get(item.feed_id) ?? "other";
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      }
    }
    return { total_unread: totalUnread, by_category: byCategory };
  };

  it("TC-SUR24: no items produces zero unread", () => {
    const signal = computeRssSignal([], []);
    expect(signal.total_unread).toBe(0);
    expect(signal.by_category).toEqual({});
  });

  it("TC-SUR25: all-read items produce zero unread", () => {
    const signal = computeRssSignal(
      [
        { is_read: true, feed_id: 1 },
        { is_read: true, feed_id: 2 },
      ],
      [{ id: 1, category: "tech" }, { id: 2, category: "finance" }]
    );
    expect(signal.total_unread).toBe(0);
  });

  it("TC-SUR26: items with is_read=undefined are treated as unread", () => {
    // is_read omitted → !undefined === true → counted as unread
    const signal = computeRssSignal(
      [{ feed_id: 1 }],  // no is_read field
      [{ id: 1, category: "tech" }]
    );
    expect(signal.total_unread).toBe(1);
  });

  it("TC-SUR27: items from unknown feed_id fall into 'other' category", () => {
    const signal = computeRssSignal(
      [{ is_read: false, feed_id: 99 }],
      [{ id: 1, category: "tech" }] // feed 99 not in the feeds array
    );
    expect(signal.by_category["other"]).toBe(1);
  });

  it("TC-SUR28: unread counts are correctly grouped by feed category", () => {
    const signal = computeRssSignal(
      [
        { is_read: false, feed_id: 1 },
        { is_read: false, feed_id: 1 },
        { is_read: false, feed_id: 2 },
        { is_read: true, feed_id: 1 },
      ],
      [{ id: 1, category: "tech" }, { id: 2, category: "finance" }]
    );
    expect(signal.total_unread).toBe(3);
    expect(signal.by_category["tech"]).toBe(2);
    expect(signal.by_category["finance"]).toBe(1);
  });
});

// ── get_entity_card: linked-transactions merge (direct + task-mediated) ───────
// Mirrors the 4c merge/dedupe/sort logic in get_entity_card: direct customer_id
// attributions and the legacy task-mediated transactions are merged, deduped by
// id (direct wins on conflict since it is inserted first), sorted newest-first,
// and capped at 5 for display.

describe("get_entity_card — linked transactions merge", () => {
  type Tx = { id: string; date?: string | null };

  const mergeLinkedTx = (direct: Tx[], mediated: Tx[]): Tx[] => {
    const byId = new Map<string, Tx>();
    for (const t of [...direct, ...mediated]) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
    return [...byId.values()]
      .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
      .slice(0, 5);
  };

  it("TC-SUR29: a transaction in both direct and mediated sets appears once", () => {
    const merged = mergeLinkedTx(
      [{ id: "tx-1", date: "2026-05-20" }],
      [{ id: "tx-1", date: "2026-05-20" }, { id: "tx-2", date: "2026-05-19" }]
    );
    expect(merged.map((t) => t.id)).toEqual(["tx-1", "tx-2"]);
  });

  it("TC-SUR30: direct attribution wins on id conflict (inserted first)", () => {
    const merged = mergeLinkedTx(
      [{ id: "tx-1", date: "2026-05-20" }],
      [{ id: "tx-1", date: "1999-01-01" }]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].date).toBe("2026-05-20"); // the direct row, not the mediated one
  });

  it("TC-SUR31: results are sorted newest date first", () => {
    const merged = mergeLinkedTx(
      [
        { id: "a", date: "2026-01-01" },
        { id: "b", date: "2026-06-01" },
      ],
      [{ id: "c", date: "2026-03-01" }]
    );
    expect(merged.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("TC-SUR32: output is capped at 5 rows", () => {
    const direct = Array.from({ length: 8 }, (_, i) => ({
      id: `tx-${i}`,
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    }));
    expect(mergeLinkedTx(direct, [])).toHaveLength(5);
  });

  it("TC-SUR33: rows with null dates sort last and do not throw", () => {
    const merged = mergeLinkedTx(
      [{ id: "a", date: null }, { id: "b", date: "2026-05-01" }],
      []
    );
    expect(merged[0].id).toBe("b");
    expect(merged[merged.length - 1].id).toBe("a");
  });

  it("TC-SUR34: empty inputs produce an empty list", () => {
    expect(mergeLinkedTx([], [])).toHaveLength(0);
  });
});
