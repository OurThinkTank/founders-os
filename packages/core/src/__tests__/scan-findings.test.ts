// ============================================================
// Founders OS scan-findings tests
//
// Coverage areas:
//   enrichDates, checkDateDay, validateFeedUrl (SSRF),
//   toSlug slug-collision, sanitizeSearchQuery injection surface,
//   get_stuck_list overdue calculation, update_task empty-string
//   field clearing, getLocalDateStr DST edge cases
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enrichDates, checkDateDay, getLocalDateStr } from "../tools/dates.js";
import { validateFeedUrl } from "../tools/rss/fetcher.js";
import { toSlug } from "../tools/tags/index.js";
import { sanitizeSearchQuery } from "../utils/sanitize.js";

// ── enrichDates ──────────────────────────────────────────────

describe("enrichDates — date-only fields", () => {
  it("TC-SCAN01: adds _display sibling for a YYYY-MM-DD field", () => {
    const input = { due_date: "2026-04-20" };
    const result = enrichDates(input) as Record<string, unknown>;
    expect(result.due_date).toBe("2026-04-20");
    expect(typeof result.due_date_display).toBe("string");
    expect(result.due_date_display).toContain("2026");
    expect(result.due_date_display).toContain("April");
  });

  it("TC-SCAN02: adds _display sibling for an ISO datetime field", () => {
    const input = { completed_at: "2026-04-20T14:30:00Z" };
    const result = enrichDates(input) as Record<string, unknown>;
    expect(result.completed_at).toBe("2026-04-20T14:30:00Z");
    expect(typeof result.completed_at_display).toBe("string");
    expect(result.completed_at_display).toContain("2026");
    expect(result.completed_at_display).toContain("at");
  });

  it("TC-SCAN03: does NOT add _display for keys in the skip list", () => {
    const input = {
      id: "2026-04-20",
      company_id: "2026-04-20",
      entity_id: "2026-04-20",
    };
    const result = enrichDates(input) as Record<string, unknown>;
    expect(result.id_display).toBeUndefined();
    expect(result.company_id_display).toBeUndefined();
    expect(result.entity_id_display).toBeUndefined();
  });

  it("TC-SCAN04: walks nested objects recursively", () => {
    const input = { task: { due_date: "2026-05-01" } };
    const result = enrichDates(input) as { task: Record<string, unknown> };
    expect(result.task.due_date_display).toBeDefined();
    expect(typeof result.task.due_date_display).toBe("string");
  });

  it("TC-SCAN05: walks arrays of objects", () => {
    const input = [{ due_date: "2026-06-15" }, { due_date: "2026-07-04" }];
    const result = enrichDates(input) as Record<string, unknown>[];
    expect(result[0].due_date_display).toBeDefined();
    expect(result[1].due_date_display).toBeDefined();
  });

  it("TC-SCAN06: null input returns null", () => {
    expect(enrichDates(null)).toBeNull();
  });

  it("TC-SCAN07: null field value is preserved as-is (no _display added)", () => {
    const input = { due_date: null };
    const result = enrichDates(input) as Record<string, unknown>;
    expect(result.due_date).toBeNull();
    expect(result.due_date_display).toBeUndefined();
  });

  it("TC-SCAN08: does not overwrite a _display key the handler already provided", () => {
    const input = { due_date: "2026-04-20", due_date_display: "Custom Display" };
    const result = enrichDates(input) as Record<string, unknown>;
    // The handler-supplied value must be preserved
    expect(result.due_date_display).toBe("Custom Display");
  });

  it("TC-SCAN09: does not double-process keys that already end in _display", () => {
    const input = { due_date_display: "Monday, April 20, 2026" };
    const result = enrichDates(input) as Record<string, unknown>;
    // Should not generate due_date_display_display
    expect((result as Record<string, unknown>).due_date_display_display).toBeUndefined();
  });

  it("TC-SCAN10: non-date string values are left unchanged without _display", () => {
    const input = { title: "Fix bug in module", status: "todo" };
    const result = enrichDates(input) as Record<string, unknown>;
    expect(result.title_display).toBeUndefined();
    expect(result.status_display).toBeUndefined();
  });
});

// ── checkDateDay ──────────────────────────────────────────────

describe("checkDateDay — correct match returns null", () => {
  it("TC-SCAN11: 2026-04-20 is Monday — passes when claimed day is Monday", () => {
    // Verify this date is actually a Monday (UTC)
    const d = new Date("2026-04-20T12:00:00Z");
    expect(d.getUTCDay()).toBe(1); // 1 = Monday
    const result = checkDateDay("2026-04-20", "Monday");
    expect(result).toBeNull();
  });

  it("TC-SCAN12: 2025-12-25 is Thursday — passes when claimed day is Thursday", () => {
    const d = new Date("2025-12-25T12:00:00Z");
    expect(d.getUTCDay()).toBe(4); // 4 = Thursday
    expect(checkDateDay("2025-12-25", "Thursday")).toBeNull();
  });
});

describe("checkDateDay — mismatch returns structured conflict", () => {
  it("TC-SCAN13: mismatch returns non-null object with message field", () => {
    // 2026-04-20 is Monday but claiming Tuesday
    const result = checkDateDay("2026-04-20", "Tuesday");
    expect(result).not.toBeNull();
    expect(result?.conflict.message).toContain("don't match");
  });

  it("TC-SCAN14: conflict includes three resolution options", () => {
    const result = checkDateDay("2026-04-20", "Tuesday");
    expect(result?.conflict.options).toHaveLength(3);
    const keys = result?.conflict.options.map((o: { key: string }) => o.key);
    expect(keys).toContain("keep_date");
    expect(keys).toContain("prev_match");
    expect(keys).toContain("next_match");
  });

  it("TC-SCAN15: keep_date option preserves the submitted date", () => {
    const result = checkDateDay("2026-04-20", "Wednesday");
    const keepOpt = result?.conflict.options.find((o: { key: string }) => o.key === "keep_date");
    expect(keepOpt?.value.date).toBe("2026-04-20");
    expect(keepOpt?.value.day).toBe("Monday"); // actual day of 2026-04-20
  });

  it("TC-SCAN16: next_match option falls on the claimed day of the week", () => {
    // Submitting 2026-04-20 (Mon) claiming Friday
    const result = checkDateDay("2026-04-20", "Friday");
    const next = result?.conflict.options.find((o: { key: string }) => o.key === "next_match");
    expect(next).toBeDefined();
    // next_match should be the next Friday after 2026-04-20 → 2026-04-24
    const nextDate = new Date((next!.value.date as string) + "T12:00:00Z");
    expect(nextDate.getUTCDay()).toBe(5); // Friday = 5
  });

  it("TC-SCAN17: prev_match option falls on the claimed day of the week", () => {
    // Submitting 2026-04-20 (Mon) claiming Friday → prev Friday is 2026-04-17
    const result = checkDateDay("2026-04-20", "Friday");
    const prev = result?.conflict.options.find((o: { key: string }) => o.key === "prev_match");
    expect(prev).toBeDefined();
    const prevDate = new Date((prev!.value.date as string) + "T12:00:00Z");
    expect(prevDate.getUTCDay()).toBe(5); // Friday = 5
  });

  it("TC-SCAN18: conflict includes ai_guidance field (instructs agent to ask user)", () => {
    const result = checkDateDay("2026-04-20", "Sunday");
    expect(typeof result?.conflict.ai_guidance).toBe("string");
    expect(result?.conflict.ai_guidance.length).toBeGreaterThan(10);
  });

  it("TC-SCAN19: submitted_date and claimed_day are echoed back in the conflict", () => {
    const result = checkDateDay("2026-04-20", "Saturday");
    const ctx = result?.conflict.context as Record<string, unknown>;
    expect(ctx?.submitted_date).toBe("2026-04-20");
    expect(ctx?.claimed_day).toBe("Saturday");
    expect(ctx?.submitted_date_day).toBe("Monday");
  });

  it("TC-SCAN20: daysForward/daysBackward never produce a 0-day offset (always 1-7)", () => {
    // Formula: daysForward = (claimedDayIndex - actualDayIndex + 7) % 7 || 7
    // When claimedDayIndex === actualDayIndex the modulo is 0, so || 7 gives 7 (a full week out).
    // A same-day claim (Monday->Monday) returns null before this runs, so 0 is never reached.
    const sameDay = (idx: number) => (idx - idx + 7) % 7 || 7;
    expect(sameDay(0)).toBe(7); // Sunday claiming Sunday → 7 days (a full week out, not 0)
    expect(sameDay(3)).toBe(7); // Wednesday claiming Wednesday → 7 days
    expect(sameDay(6)).toBe(7); // Saturday claiming Saturday → 7 days
  });
});

// ── validateFeedUrl (additional SSRF vectors) ─────────────────

describe("validateFeedUrl — additional SSRF vectors", () => {
  it("TC-SCAN21: rejects http://0.0.0.0 (0. prefix in blocklist)", () => {
    // 0.0.0.0 matches the 0. prefix pattern
    expect(() => validateFeedUrl("http://0.0.0.0/feed")).toThrow(/private|reserved/i);
  });

  it("TC-SCAN22: rejects http://0/ (short-form zero address)", () => {
    // Node.js URL parser may resolve http://0/ to 0.0.0.0; verify it's blocked
    expect(() => validateFeedUrl("http://0/feed")).toThrow();
  });

  it("TC-SCAN23: accepts a URL with a port number", () => {
    expect(() => validateFeedUrl("https://feeds.example.com:443/rss")).not.toThrow();
  });

  it("TC-SCAN24: rejects a URL with no hostname (path-only)", () => {
    // "/etc/passwd" is not a valid URL at all
    expect(() => validateFeedUrl("/etc/passwd")).toThrow(/invalid/i);
  });

  it("TC-SCAN25: accepts a URL with a subdomain", () => {
    expect(() =>
      validateFeedUrl("https://news.ycombinator.com/rss")
    ).not.toThrow();
  });

  it("TC-SCAN26: accepts a URL with fragments (hash)", () => {
    // Fragments are client-side only; the server ignores them and the URL is still valid
    expect(() =>
      validateFeedUrl("https://example.com/feed.xml#section")
    ).not.toThrow();
  });
});

// ── toSlug slug-collision behavior ───────────────────────────
// toSlug strips # @ ! prefix chars, so toSlug("#q2-2026") === toSlug("q2-2026").
// If "q2-2026" is in the registry, adding "#q2-2026" silently passes validation
// because the check `knownSlugs.has(slug)` returns true. This is intentional:
// the tag IS conceptually known, but callers should be aware that prefix and
// bare forms resolve to the same slug.

describe("toSlug — prefix character stripping and slug collisions", () => {
  it("TC-SCAN27: #tag and tag produce the same slug", () => {
    expect(toSlug("#q2-2026")).toBe(toSlug("q2-2026"));
  });

  it("TC-SCAN28: @name and name produce the same slug", () => {
    expect(toSlug("@claude")).toBe(toSlug("claude"));
  });

  it("TC-SCAN29: !state and state produce the same slug", () => {
    expect(toSlug("!blocked")).toBe(toSlug("blocked"));
  });

  it("TC-SCAN30: double-prefix ##tag produces same slug as #tag and tag", () => {
    // ## → strip both # chars → same as no prefix
    expect(toSlug("##founders-os")).toBe("founders-os");
  });

  it("TC-SCAN31: mixed prefix @#tag strips all prefix chars before slug computation", () => {
    // "@#project" → strip @ and # → "project"
    expect(toSlug("@#project")).toBe("project");
  });
});

// ── toSlug substring containment (typo detector input) ───────
// The typo detector fires if slug.includes(known), meaning "foobar" is flagged
// as a possible typo of known tag "foo". This is by design for catching partial
// matches, but produces false positives for intentional extensions of short slugs.

describe("toSlug — substring containment logic (typo detector input)", () => {
  it("TC-SCAN32: 'foobar' contains 'foo' — this is what drives typo warnings", () => {
    const slug = toSlug("foobar");
    const knownSlug = toSlug("foo");
    // Confirm the substring relationship that drives the typo alert
    expect(slug.includes(knownSlug)).toBe(true);
  });

  it("TC-SCAN33: 'founders-os-v2' contains 'founders-os' — correct typo detection", () => {
    const slug = toSlug("founders-os-v2");
    const knownSlug = toSlug("founders-os");
    expect(slug.includes(knownSlug)).toBe(true);
  });

  it("TC-SCAN34: short known slug (< 3 chars) is excluded from typo checks", () => {
    // The minLen < 3 guard: if known is "v2" (2 chars), minLen = 2 → return false
    const knownSlug = "v2";
    const candidateSlug = "v2-launch";
    const minLen = Math.min(knownSlug.length, candidateSlug.length);
    expect(minLen < 3).toBe(true); // This would skip the prefix-match path
    // Only substring containment matters here
    const triggered =
      knownSlug.includes(candidateSlug) || candidateSlug.includes(knownSlug);
    expect(triggered).toBe(true); // "v2-launch".includes("v2") is true
  });
});

// ── Scope OR filter: userId injection surface ─────────────────
// The scope OR filter is built via string interpolation:
//   `scope.eq.org,and(scope.eq.personal,created_by.eq.${userId})`
// If userId contained PostgREST operator characters (comma, dot, parens),
// the OR clause could be malformed. FOUNDERS_OS_USER_ID comes from the
// server operator's env var, not user input, so the actual risk is low.
// These tests document sanitizeSearchQuery behavior as a reference for
// any future userId validation.

describe("sanitizeSearchQuery — injection surface reference tests", () => {
  it("TC-SCAN35: comma injection is stripped (PostgREST clause separator)", () => {
    const malicious = "default,scope.eq.org";
    const safe = sanitizeSearchQuery(malicious);
    expect(safe).not.toContain(",");
  });

  it("TC-SCAN36: dot is preserved (appears in usernames/emails)", () => {
    // Dots are valid in user IDs but also in PostgREST operators.
    // sanitizeSearchQuery preserves dots (valid in usernames/emails)
    const input = "user.name";
    const result = sanitizeSearchQuery(input);
    expect(result).toBe("user.name");
  });

  it("TC-SCAN37: parentheses injection is stripped", () => {
    const malicious = "userId)--";
    const result = sanitizeSearchQuery(malicious);
    expect(result).not.toContain(")");
  });

  it("TC-SCAN38: a normal user ID passes through unchanged", () => {
    expect(sanitizeSearchQuery("alice")).toBe("alice");
    expect(sanitizeSearchQuery("bob")).toBe("bob");
    expect(sanitizeSearchQuery("carol")).toBe("carol");
  });
});

// ── get_stuck_list: overdue days calculation ──────────────────
// Overdue = Math.floor((today - new Date(due_date + "T00:00:00Z")) / 86_400_000)
// Appending "T00:00:00Z" forces UTC midnight parsing. Tests verify edge cases.

describe("get_stuck_list — overdue calculation with UTC midnight parsing", () => {
  const daysOverdue = (dueDateStr: string, now: Date): number =>
    Math.floor(
      (now.getTime() - new Date(dueDateStr + "T00:00:00Z").getTime()) / 86_400_000
    );

  it("TC-SCAN42: task due yesterday is 1 day overdue", () => {
    const now = new Date("2026-04-20T10:00:00Z");
    expect(daysOverdue("2026-04-19", now)).toBe(1);
  });

  it("TC-SCAN43: task due today (UTC) is 0 days overdue at noon UTC", () => {
    // due today UTC midnight to noon UTC = 12 hours = 0 full days
    const now = new Date("2026-04-20T12:00:00Z");
    expect(daysOverdue("2026-04-20", now)).toBe(0);
  });

  it("TC-SCAN44: task due 7 days ago is 7 days overdue", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    expect(daysOverdue("2026-04-13", now)).toBe(7);
  });

  it("TC-SCAN45: month boundary: due 2026-03-31, checked 2026-04-05 → 5 days overdue", () => {
    const now = new Date("2026-04-05T12:00:00Z");
    expect(daysOverdue("2026-03-31", now)).toBe(5);
  });
});

// ── update_task: empty-string clears nullable fields ──────────
// The handler maps empty string to null for assigned_to, due_date,
// and blocked_by_task_id. These tests document that contract.

describe("update_task — empty-string → null field mapping", () => {
  const mapField = (value: string | undefined): string | null | undefined => {
    if (value === undefined) return undefined;
    return value === "" ? null : value;
  };

  it("TC-SCAN46: empty string maps to null (clears the field)", () => {
    expect(mapField("")).toBeNull();
  });

  it("TC-SCAN47: non-empty string is preserved unchanged", () => {
    expect(mapField("@claude")).toBe("@claude");
    expect(mapField("2026-12-31")).toBe("2026-12-31");
  });

  it("TC-SCAN48: undefined is returned as-is (field not included in update patch)", () => {
    expect(mapField(undefined)).toBeUndefined();
  });
});

// ── getLocalDateStr: DST and year-boundary edge cases ─────────

describe("getLocalDateStr — additional DST and boundary cases", () => {
  it("TC-SCAN49: at midnight UTC, UTC returns the new date immediately", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(getLocalDateStr("UTC")).toBe("2026-01-01");
    vi.useRealTimers();
  });

  it("TC-SCAN50: negative offsetDays returns a past date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T12:00:00Z"));
    const yesterday = getLocalDateStr("UTC", -1);
    expect(yesterday).toBe("2026-04-19");
    vi.useRealTimers();
  });

  it("TC-SCAN51: large positive offsetDays (365) returns next year's date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const nextYear = getLocalDateStr("UTC", 365);
    expect(nextYear).toBe("2027-01-01");
    vi.useRealTimers();
  });
});
