// ============================================================
// Founders OS — Date Safety Utilities
// ============================================================
// Deterministic date formatting and enrichment so AI clients
// never have to guess the day of the week.
//
// Three exports:
//   getToday()      — timezone-aware "today" as YYYY-MM-DD
//   enrichDates()   — recursively adds _display siblings to
//                     every date string in a tool response
//   checkDateDay()  — checksum: reject if a claimed day name
//                     doesn't match the actual date (returns
//                     structured Conflict for interactive resolution)
// ============================================================

/** Auto-detected system timezone, cached at startup. */
const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Resolve the active timezone. Priority:
 * 1. FOUNDERS_OS_TIMEZONE env var (explicit override)
 * 2. System timezone via Intl (auto-detected, travels with the laptop)
 * 3. "UTC" (should never happen, but safe fallback)
 */
function getTz(): string {
  return process.env.FOUNDERS_OS_TIMEZONE ?? detectedTz ?? "UTC";
}

// ── getLocalTimezone ────────────────────────────────────────

/**
 * Return the resolved timezone string. If the caller passes one,
 * use it; otherwise fall back to getTz() (env var > auto-detect).
 */
export function getLocalTimezone(override?: string): string {
  return override ?? getTz();
}

// ── getLocalTime / getTimeOfDay ─────────────────────────────

/**
 * Return the current local time as "HH:MM" in the given timezone.
 */
export function getLocalTime(timezone?: string): string {
  const tz = timezone ?? getTz();
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(11, 16);
  }
}

/**
 * Return a time-of-day bucket based on the current local hour.
 * Agents use this for greetings and tone.
 *
 *   05:00-11:59  morning
 *   12:00-16:59  afternoon
 *   17:00-20:59  evening
 *   21:00-04:59  night
 */
export function getTimeOfDay(timezone?: string): "morning" | "afternoon" | "evening" | "night" {
  const timeStr = getLocalTime(timezone);
  const hour = parseInt(timeStr.split(":")[0], 10);
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

// ── getToday / getLocalDateStr ──────────────────────────────

/**
 * Return the current date as YYYY-MM-DD in the configured timezone.
 * Replaces `new Date().toISOString().split("T")[0]` which uses UTC.
 */
export function getToday(): string {
  // en-CA locale gives YYYY-MM-DD format natively
  return new Date().toLocaleDateString("en-CA", { timeZone: getTz() });
}

/**
 * Return a YYYY-MM-DD date string in a given timezone.
 * If no timezone is provided, falls back to the configured default.
 * Optionally offset by a number of days (positive = future).
 *
 * Used by tools that accept a per-call `timezone` parameter so the
 * AI can pass the user's local timezone for accurate "today" / "upcoming"
 * calculations.
 */
export function getLocalDateStr(timezone?: string, offsetDays?: number): string {
  const tz = timezone ?? getTz();
  const d = offsetDays ? new Date(Date.now() + offsetDays * 86_400_000) : new Date();
  try {
    return d.toLocaleDateString("en-CA", { timeZone: tz });
  } catch {
    // Invalid timezone string - fall back to UTC silently
    return d.toISOString().split("T")[0];
  }
}

// ── Date formatting ─────────────────────────────────────────

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Format a YYYY-MM-DD string as "Monday, April 20, 2026".
 * Uses UTC to avoid the date shifting when parsed.
 */
function formatDateOnly(dateStr: string): string {
  // Parse at noon UTC to avoid any DST edge-case shifting
  const d = new Date(dateStr + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/**
 * Format an ISO datetime string as "Monday, April 20, 2026 at 2:30 PM".
 * Displayed in the configured timezone.
 */
function formatDateTime(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr; // unparseable, return as-is

  const tz = getTz();

  const datePart = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  }).format(d);

  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(d);

  return `${datePart} at ${timePart}`;
}

// ── enrichDates ─────────────────────────────────────────────

/** Keys to skip enrichment on (not real dates, just look like them). */
const SKIP_KEYS = new Set(["id", "company_id", "created_by", "user_id", "entity_id", "task_id", "blocked_by_task_id", "assigned_to"]);

/**
 * Recursively walk a tool response and add `_display` siblings
 * for every date-valued key. Operates on a deep clone so the
 * original object is not mutated.
 *
 * Rules:
 * - "foo": "2026-04-20" -> adds "foo_display": "Monday, April 20, 2026"
 * - "foo": "2026-04-20T14:30:00Z" -> adds "foo_display": "Monday, April 20, 2026 at 2:30 PM"
 * - Keys ending in _display are skipped (no double-processing)
 * - Keys in SKIP_KEYS are skipped (UUIDs, IDs that happen to contain date-like strings)
 * - null values are skipped
 * - Arrays are walked element-by-element
 */
export function enrichDates(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => enrichDates(item));
  }

  if (typeof obj === "object") {
    const source = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    // First pass: copy all existing keys
    for (const [key, value] of Object.entries(source)) {
      result[key] = enrichDates(value);
    }

    // Second pass: add _display keys for date strings
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string") continue;
      if (key.endsWith("_display")) continue;
      if (SKIP_KEYS.has(key)) continue;

      const displayKey = `${key}_display`;
      // Don't overwrite if the handler already provided one
      if (displayKey in result) continue;

      if (DATE_ONLY_RE.test(value)) {
        result[displayKey] = formatDateOnly(value);
      } else if (ISO_DATETIME_RE.test(value)) {
        result[displayKey] = formatDateTime(value);
      }
    }

    return result;
  }

  return obj;
}

// ── checkDateDay ─────────────────────────────────────────────

import { conflict as buildConflict, type Conflict } from "./conflict.js";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** @deprecated Use the general Conflict type from conflict.ts */
export interface DateConflictOption {
  key: string;
  label: string;
  date: string;
  day: string;
}

/** @deprecated Use the general Conflict type from conflict.ts */
export interface DateConflict {
  message: string;
  submitted_date: string;
  submitted_date_day: string;
  submitted_date_display: string;
  claimed_day: string;
  options: DateConflictOption[];
  ai_guidance: string;
}

/**
 * Check whether a claimed day-of-week matches the actual day for a
 * YYYY-MM-DD date. Returns null if they match, or a structured
 * conflict response if they don't.
 *
 * Returns the general Conflict wrapper (`{ conflict: Conflict }`)
 * so handlers can return it directly and register.ts will detect it.
 */
export function checkDateDay(
  dateStr: string,
  claimedDay: Weekday
): { conflict: Conflict } | null {
  const d = new Date(dateStr + "T12:00:00Z");
  const actualDay = WEEKDAYS[d.getUTCDay()];

  if (actualDay === claimedDay) return null;

  // Find the nearest dates that actually fall on the claimed day
  const claimedDayIndex = WEEKDAYS.indexOf(claimedDay);
  const actualDayIndex = d.getUTCDay();

  const daysForward = (claimedDayIndex - actualDayIndex + 7) % 7 || 7;
  const daysBackward = (actualDayIndex - claimedDayIndex + 7) % 7 || 7;

  const nextDate = new Date(d.getTime() + daysForward * 86_400_000);
  const prevDate = new Date(d.getTime() - daysBackward * 86_400_000);

  const fmtDate = (dt: Date) => dt.toISOString().split("T")[0];

  const submittedDisplay = formatDateOnly(dateStr);

  return buildConflict(
    "validation_mismatch",
    "The date and day of week don't match - which did you mean?",
    [
      {
        key: "keep_date",
        label: `Keep ${formatDateOnly(dateStr)}`,
        value: { date: dateStr, day: actualDay },
      },
      {
        key: "prev_match",
        label: formatDateOnly(fmtDate(prevDate)),
        value: { date: fmtDate(prevDate), day: claimedDay },
      },
      {
        key: "next_match",
        label: formatDateOnly(fmtDate(nextDate)),
        value: { date: fmtDate(nextDate), day: claimedDay },
      },
    ],
    {
      submitted_date: dateStr,
      submitted_date_day: actualDay,
      submitted_date_display: submittedDisplay,
      claimed_day: claimedDay,
    }
  );
}
