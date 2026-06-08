// ============================================================
// Tests for src/tools/dates.ts - getLocalDateStr
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getLocalDateStr } from "../tools/dates.js";

// YYYY-MM-DD regex
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

describe("getLocalDateStr", () => {
  // ── Basic format validation ──────────────────────────────────────────────

  it("TC-D01: returns a YYYY-MM-DD string when called with no arguments", () => {
    const result = getLocalDateStr();
    expect(result).toMatch(DATE_RE);
  });

  it("TC-D02: returns a YYYY-MM-DD string for a valid IANA timezone", () => {
    const result = getLocalDateStr("America/New_York");
    expect(result).toMatch(DATE_RE);
  });

  it("TC-D03: returns a valid date even for an invalid timezone string", () => {
    // Our implementation uses the FOUNDERS_OS_TIMEZONE env var as fallback,
    // so we just verify it still returns a well-formed date string.
    const result = getLocalDateStr("Not/A/Real_Zone");
    expect(result).toMatch(DATE_RE);
  });

  // ── Timezone offset correctness ──────────────────────────────────────────

  it("TC-D04: Pacific time is behind UTC — date is never ahead of UTC", () => {
    // Pacific is UTC-7 or UTC-8; its local date can be at most 1 day behind UTC.
    const utcDate = new Date().toISOString().split("T")[0];
    const ptDate = getLocalDateStr("America/Los_Angeles");
    expect(ptDate <= utcDate).toBe(true);
  });

  it("TC-D05: Asia/Tokyo is ahead of UTC — date is never behind UTC", () => {
    const utcDate = new Date().toISOString().split("T")[0];
    const tokyoDate = getLocalDateStr("Asia/Tokyo");
    expect(tokyoDate >= utcDate).toBe(true);
  });

  it("TC-D06: UTC timezone matches plain UTC date", () => {
    const utc = new Date().toISOString().split("T")[0];
    const result = getLocalDateStr("UTC");
    expect(result).toBe(utc);
  });

  // ── Offset days ──────────────────────────────────────────────────────────

  it("TC-D07: offsetDays=0 returns same date as no offset", () => {
    const base = getLocalDateStr("UTC");
    const withZero = getLocalDateStr("UTC", 0);
    expect(withZero).toBe(base);
  });

  it("TC-D08: offsetDays=1 returns tomorrow in UTC", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split("T")[0];
    const result = getLocalDateStr("UTC", 1);
    expect(result).toBe(tomorrow);
  });

  it("TC-D09: offsetDays=7 returns a date 7 days in the future", () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString().split("T")[0];
    const result = getLocalDateStr("UTC", 7);
    expect(result).toBe(future);
  });

  it("TC-D10: offsetDays=-1 returns yesterday in UTC", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().split("T")[0];
    const result = getLocalDateStr("UTC", -1);
    expect(result).toBe(yesterday);
  });

  // ── Critical timezone boundary: western hemisphere after 7 pm UTC ───────

  it("TC-D11: at 23:30 UTC, America/New_York is still on the previous calendar day", () => {
    // Simulate 23:30 UTC on 2025-03-15 (a Saturday)
    // New York is UTC-4 (EDT) in March, so local time is 19:30 → still Mar 15
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-15T23:30:00Z"));

    const nyDate = getLocalDateStr("America/New_York");
    // NY (EDT = UTC-4) is 19:30, still March 15
    expect(nyDate).toBe("2025-03-15");

    vi.useRealTimers();
  });

  it("TC-D12: at 23:30 UTC, UTC itself is already on the next calendar day boundary", () => {
    // UTC on 2025-03-15 at 23:30 is still 2025-03-15 in UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-15T23:30:00Z"));

    const utcDate = getLocalDateStr("UTC");
    expect(utcDate).toBe("2025-03-15");

    vi.useRealTimers();
  });

  it("TC-D13: after midnight UTC, New York is still on the prior day (classic off-by-one bug)", () => {
    // 00:30 UTC on 2025-03-16 → NY (EDT, UTC-4) is 20:30 on 2025-03-15
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-16T00:30:00Z"));

    const utcDate = getLocalDateStr("UTC"); // explicit UTC
    const nyDate = getLocalDateStr("America/New_York");

    expect(utcDate).toBe("2025-03-16"); // UTC sees the next day already
    expect(nyDate).toBe("2025-03-15"); // NY is still on the prior day (the original bug)

    vi.useRealTimers();
  });
});
