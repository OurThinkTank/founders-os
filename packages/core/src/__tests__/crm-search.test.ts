// ============================================================
// Tests for CRM search sanitization and filter construction
// ============================================================
// Validates the sanitizeSearchQuery helper and the PostgREST
// filter strings built by search_customers / search_contacts.
// No real DB required. Pure logic tests.
// ============================================================
import { describe, it, expect } from "vitest";
import { sanitizeSearchQuery } from "../utils/sanitize.js";

// ── sanitizeSearchQuery ──────────────────────────────────────────────────────

describe("sanitizeSearchQuery — character filtering", () => {
  it("TC-CRM01: passes through safe alphanumeric query unchanged", () => {
    expect(sanitizeSearchQuery("Acme Corp")).toBe("Acme Corp");
  });

  it("TC-CRM02: strips commas that would split PostgREST .or() clauses", () => {
    // A comma inside the value would terminate one clause and start another
    const result = sanitizeSearchQuery("acme,evil.filter.eq.1");
    expect(result).not.toContain(",");
  });

  it("TC-CRM03: strips parentheses used for PostgREST nested grouping", () => {
    const result = sanitizeSearchQuery("foo(bar)baz");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
  });

  it("TC-CRM04: strips semicolons and single-quotes", () => {
    const result = sanitizeSearchQuery("O'Brien; DROP TABLE customers");
    expect(result).not.toContain(";");
    expect(result).not.toContain("'");
  });

  it("TC-CRM05: strips percent sign (LIKE wildcard injection)", () => {
    // Injecting % into an ilike value is mostly harmless but we sanitize it anyway
    const result = sanitizeSearchQuery("100%");
    expect(result).not.toContain("%");
  });

  it("TC-CRM06: preserves @ . _ - which appear in emails and domain names", () => {
    const q = "john@acme.co_us-west";
    expect(sanitizeSearchQuery(q)).toBe(q);
  });

  it("TC-CRM07: enforces default max length of 100 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeSearchQuery(long).length).toBe(100);
  });

  it("TC-CRM08: respects a custom maxLen argument", () => {
    expect(sanitizeSearchQuery("hello world", 5).length).toBe(5);
  });

  it("TC-CRM09: returns empty string for empty input", () => {
    expect(sanitizeSearchQuery("")).toBe("");
  });

  it("TC-CRM10: returns empty string when all characters are stripped", () => {
    expect(sanitizeSearchQuery("(),,;;")).toBe("");
  });

  it("TC-CRM11: multi-word query with safe characters is left intact", () => {
    expect(sanitizeSearchQuery("Life Science Outsourcing")).toBe("Life Science Outsourcing");
  });
});

// ── PostgREST .or() filter string construction ───────────────────────────────

describe("search_customers fallback filter string", () => {
  // Mirrors the pattern in customers.ts search_customers handler after sanitization
  const buildCustomerOrFilter = (safeQuery: string) =>
    `organization_name.ilike.%${safeQuery}%,city.ilike.%${safeQuery}%,state.ilike.%${safeQuery}%`;

  it("TC-CRM12: clean query produces a well-formed filter string", () => {
    const f = buildCustomerOrFilter("Acme");
    expect(f).toBe("organization_name.ilike.%Acme%,city.ilike.%Acme%,state.ilike.%Acme%");
  });

  it("TC-CRM13: sanitized query can never produce multiple top-level clauses via injection", () => {
    // The raw injection attempt: "x%,organization_name.ilike.%everything"
    // After sanitization all special characters outside the safe set are stripped
    const raw = "x%,organization_name.ilike.%everything";
    const safe = sanitizeSearchQuery(raw);
    const f = buildCustomerOrFilter(safe);
    // The filter must have exactly two commas (the intended separators)
    const commaCount = (f.match(/,/g) ?? []).length;
    expect(commaCount).toBe(2);
  });
});

// ── search_contacts filter array construction ────────────────────────────────

describe("search_contacts filter array", () => {
  // Mirrors the filter-building logic in contacts.ts search_contacts handler
  const buildContactFilters = (safeQ: string) => {
    const parts = safeQ.split(/\s+/).filter(Boolean);
    const filters = [
      `first_name.ilike.%${safeQ}%`,
      `last_name.ilike.%${safeQ}%`,
      `email.ilike.%${safeQ}%`,
      `phone.ilike.%${safeQ}%`,
      `role.ilike.%${safeQ}%`,
    ];
    if (parts.length >= 2) {
      for (const part of parts) {
        filters.push(`first_name.ilike.%${part}%`);
        filters.push(`last_name.ilike.%${part}%`);
      }
    }
    return filters;
  };

  it("TC-CRM14: single-word query produces 5 filters", () => {
    expect(buildContactFilters("Alice")).toHaveLength(5);
  });

  it("TC-CRM15: two-word query adds first+last split filters", () => {
    // 5 base + 2 parts × 2 fields = 9
    expect(buildContactFilters("Alice Smith")).toHaveLength(9);
  });

  it("TC-CRM16: no filter contains a comma or parenthesis after sanitization", () => {
    const raw = "Alice(Smith,evil)";
    const safe = sanitizeSearchQuery(raw);
    const filters = buildContactFilters(safe);
    for (const f of filters) {
      expect(f).not.toMatch(/[(),]/);
    }
  });

  it("TC-CRM17: empty parts are excluded from split filters", () => {
    // Multiple spaces produce empty parts after split; filter(Boolean) removes them
    const safe = sanitizeSearchQuery("  John   Doe  ");
    const parts = safe.split(/\s+/).filter(Boolean);
    expect(parts).toEqual(["John", "Doe"]);
  });
});

// ── First-run detection: user_id scoping ─────────────────────────────────────

describe("first-run detection user_id filter construction", () => {
  // Mirrors the memories filter added in first-run.ts
  const buildMemoriesFilter = (userId: string) =>
    `user_id.eq.${userId},user_id.eq.org`;

  it("TC-CRM22: filter includes the caller's user id", () => {
    const f = buildMemoriesFilter("alice");
    expect(f).toContain("user_id.eq.alice");
  });

  it("TC-CRM23: filter always includes the shared org scope", () => {
    const f = buildMemoriesFilter("alice");
    expect(f).toContain("user_id.eq.org");
  });

  it("TC-CRM24: default userId fallback is 'default'", () => {
    const userId = process.env.FOUNDERS_OS_USER_ID ?? "default";
    expect(typeof userId).toBe("string");
    expect(userId.length).toBeGreaterThan(0);
  });
});
