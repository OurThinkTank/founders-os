// ============================================================
// Tests for task tool logic: parameter handling, defaults,
// and boundary conditions. No real DB required.
// ============================================================
import { describe, it, expect } from "vitest";

// ── Task status defaulting ───────────────────────────────────────────────────

describe("Task status logic", () => {
  // Mirrors: effectiveStatus in create_task handler
  const effectiveStatus = (
    blocked_by_task_id: string | undefined,
    status: string | undefined
  ): string => {
    return blocked_by_task_id && !status ? "blocked" : (status ?? "todo");
  };

  it("TC-TSK01: no status and no blocker → defaults to 'todo'", () => {
    expect(effectiveStatus(undefined, undefined)).toBe("todo");
  });

  it("TC-TSK02: blocked_by_task_id set with no status → auto-sets to 'blocked'", () => {
    expect(effectiveStatus("some-uuid", undefined)).toBe("blocked");
  });

  it("TC-TSK03: explicit status overrides the auto-blocked default", () => {
    // If caller sets status explicitly, honour it even with a blocker
    expect(effectiveStatus("some-uuid", "todo")).toBe("todo");
  });

  it("TC-TSK04: status=done is honoured even with a blocker set", () => {
    expect(effectiveStatus("some-uuid", "done")).toBe("done");
  });

  it("TC-TSK05: status without blocker is passed through unchanged", () => {
    expect(effectiveStatus(undefined, "in_progress")).toBe("in_progress");
  });
});

// ── Task priority defaults ────────────────────────────────────────────────────

describe("Task priority defaults", () => {
  const resolveP = (priority?: string) => priority ?? "medium";

  it("TC-TSK06: no priority → defaults to 'medium'", () => {
    expect(resolveP(undefined)).toBe("medium");
  });

  it("TC-TSK07: explicit priority is preserved", () => {
    expect(resolveP("urgent")).toBe("urgent");
    expect(resolveP("low")).toBe("low");
  });
});

// ── Due date regex validation (from Zod schema) ──────────────────────────────

describe("Due date format validation", () => {
  const isDueDateValid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

  it("TC-TSK08: valid ISO date passes", () => {
    expect(isDueDateValid("2025-12-31")).toBe(true);
  });

  it("TC-TSK09: datetime string fails (extra time component)", () => {
    expect(isDueDateValid("2025-12-31T00:00:00Z")).toBe(false);
  });

  it("TC-TSK10: US date format MM/DD/YYYY fails", () => {
    expect(isDueDateValid("12/31/2025")).toBe(false);
  });

  it("TC-TSK11: empty string fails", () => {
    expect(isDueDateValid("")).toBe(false);
  });

  it("TC-TSK12: partial date fails", () => {
    expect(isDueDateValid("2025-12")).toBe(false);
  });
});

// ── update_task due_date clear semantics ─────────────────────────────────────
// Mirrors the refined Zod schema on update_task: accepts YYYY-MM-DD or empty
// string (empty string is the documented escape hatch the handler maps to
// NULL). The original strict regex rejected "" before the handler ran, making
// the documented behavior unreachable. Regression guard for that bug.

describe("update_task due_date clear semantics", () => {
  const isUpdateDueDateValid = (s: string) =>
    s === "" || /^\d{4}-\d{2}-\d{2}$/.test(s);

  it("TC-TSK11b: empty string passes update_task schema (clear sentinel)", () => {
    expect(isUpdateDueDateValid("")).toBe(true);
  });

  it("TC-TSK11c: valid ISO date still passes update_task schema", () => {
    expect(isUpdateDueDateValid("2026-05-21")).toBe(true);
  });

  it("TC-TSK11d: malformed date still fails update_task schema", () => {
    expect(isUpdateDueDateValid("not-a-date")).toBe(false);
    expect(isUpdateDueDateValid("2026-5-21")).toBe(false);
  });

  // Mirrors the handler mapping at update_task: fields.due_date === "" → null
  const resolveDueDateUpdate = (v: string | undefined): string | null | undefined => {
    if (v === undefined) return undefined; // field not provided: don't update
    return v === "" ? null : v;
  };

  it("TC-TSK11e: empty-string maps to null (clears the field)", () => {
    expect(resolveDueDateUpdate("")).toBeNull();
  });

  it("TC-TSK11f: undefined leaves the field untouched", () => {
    expect(resolveDueDateUpdate(undefined)).toBeUndefined();
  });

  it("TC-TSK11g: ISO date passes through unchanged", () => {
    expect(resolveDueDateUpdate("2026-05-21")).toBe("2026-05-21");
  });
});

// ── Scope filter construction ─────────────────────────────────────────────────

describe("Scope OR filter string construction", () => {
  // Mirrors the scopeOrFilter used throughout task handlers
  const buildScopeFilter = (userId: string) =>
    `scope.eq.org,and(scope.eq.personal,created_by.eq.${userId})`;

  it("TC-TSK13: scope filter includes org clause", () => {
    const f = buildScopeFilter("user123");
    expect(f).toContain("scope.eq.org");
  });

  it("TC-TSK14: scope filter includes personal clause with user ID", () => {
    const f = buildScopeFilter("user123");
    expect(f).toContain("created_by.eq.user123");
  });

  it("TC-TSK15: scope filter format is correct PostgREST OR syntax", () => {
    const f = buildScopeFilter("user123");
    expect(f).toBe("scope.eq.org,and(scope.eq.personal,created_by.eq.user123)");
  });
});

// ── Stuck list: days_stale calculation ──────────────────────────────────────

describe("Days stale calculation", () => {
  const daysStale = (updatedAt: string, now: Date): number =>
    Math.floor((now.getTime() - new Date(updatedAt).getTime()) / 86_400_000);

  it("TC-TSK19: task updated exactly 7 days ago → 7 days stale", () => {
    const now = new Date("2025-03-15T12:00:00Z");
    const updatedAt = "2025-03-08T12:00:00Z";
    expect(daysStale(updatedAt, now)).toBe(7);
  });

  it("TC-TSK20: task updated today → 0 days stale", () => {
    const now = new Date("2025-03-15T12:00:00Z");
    const updatedAt = "2025-03-15T10:00:00Z";
    expect(daysStale(updatedAt, now)).toBe(0);
  });

  it("TC-TSK21: floor truncates partial days correctly", () => {
    const now = new Date("2025-03-15T12:00:00Z");
    const updatedAt = "2025-03-08T13:00:00Z"; // 6 days 23 hours ago
    expect(daysStale(updatedAt, now)).toBe(6); // floor, not round
  });
});
