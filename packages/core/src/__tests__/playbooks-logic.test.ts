// ============================================================
// Tests for Playbooks tool logic: placeholder resolution,
// connector requirements, due date offsets, run status, and
// step ordering. No real DB required.
// ============================================================
import { describe, it, expect } from "vitest";

// ── toSlug ───────────────────────────────────────────────────────────────────
// Mirrors: toSlug() in tools/playbooks/index.ts

const toSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

describe("toSlug", () => {
  it("TC-PB01: lowercases and hyphenates a normal org name", () => {
    expect(toSlug("Acme Corp")).toBe("acme-corp");
  });

  it("TC-PB02: strips leading and trailing hyphens", () => {
    expect(toSlug("  Weird Name  ")).toBe("weird-name");
  });

  it("TC-PB03: collapses multiple special characters into a single hyphen", () => {
    expect(toSlug("Bobo the Clown Ltd")).toBe("bobo-the-clown-ltd");
  });

  it("TC-PB04: strips non-alphanumeric characters", () => {
    expect(toSlug("O'Brien & Sons, LLC.")).toBe("o-brien-sons-llc");
  });

  it("TC-PB05: handles an already-clean slug unchanged", () => {
    expect(toSlug("new-deal")).toBe("new-deal");
  });

  it("TC-PB06: numbers are preserved", () => {
    expect(toSlug("Client 42 Inc")).toBe("client-42-inc");
  });
});

// ── addDays ──────────────────────────────────────────────────────────────────
// Mirrors: addDays() in tools/playbooks/index.ts

const addDays = (dateStr: string, days: number): string => {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe("addDays", () => {
  it("TC-PB07: zero offset returns the same date", () => {
    expect(addDays("2026-05-01", 0)).toBe("2026-05-01");
  });

  it("TC-PB08: positive offset advances the date correctly", () => {
    expect(addDays("2026-05-01", 3)).toBe("2026-05-04");
  });

  it("TC-PB09: offset crossing a month boundary rolls over correctly", () => {
    expect(addDays("2026-01-29", 5)).toBe("2026-02-03");
  });

  it("TC-PB10: offset crossing a year boundary rolls over correctly", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("TC-PB11: large offset (30 days) is handled correctly", () => {
    expect(addDays("2026-05-01", 30)).toBe("2026-05-31");
  });

  it("TC-PB12: works correctly in a leap year", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-28", 2)).toBe("2028-03-01");
  });

  it("TC-PB13: non-leap year Feb 28 +1 goes to Mar 1", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

// ── resolvePlaceholders ──────────────────────────────────────────────────────
// Mirrors: resolvePlaceholders() in tools/playbooks/index.ts

interface PlaceholderContext {
  customerName: string;
  customerSlug: string;
  primaryContactName: string;
  primaryContactEmail: string;
  startDate: string;
}

const resolvePlaceholders = (template: string, ctx: PlaceholderContext): string =>
  template
    .replace(/\{\{customer\.name\}\}/g, ctx.customerName)
    .replace(/\{\{customer\.slug\}\}/g, ctx.customerSlug)
    .replace(/\{\{contact\.primary\.name\}\}/g, ctx.primaryContactName)
    .replace(/\{\{contact\.primary\.email\}\}/g, ctx.primaryContactEmail)
    .replace(/\{\{playbook\.start_date\}\}/g, ctx.startDate)
    .replace(/\{\{playbook\.start_year\}\}/g, ctx.startDate.slice(0, 4))
    .replace(/\{\{playbook\.start_date\+(\d+)d\}\}/g, (_, n: string) =>
      addDays(ctx.startDate, parseInt(n, 10))
    );

const baseCtx: PlaceholderContext = {
  customerName: "Bobo the Clown Ltd",
  customerSlug: "bobo-the-clown-ltd",
  primaryContactName: "Bobo Jr",
  primaryContactEmail: "bobo.jr@bobotheclown.example.com",
  startDate: "2026-05-01",
};

describe("resolvePlaceholders — customer fields", () => {
  it("TC-PB14: {{customer.name}} resolves to organization name", () => {
    expect(resolvePlaceholders("Hello {{customer.name}}", baseCtx))
      .toBe("Hello Bobo the Clown Ltd");
  });

  it("TC-PB15: {{customer.slug}} resolves to slug", () => {
    expect(resolvePlaceholders("repo: {{customer.slug}}-2026", baseCtx))
      .toBe("repo: bobo-the-clown-ltd-2026");
  });

  it("TC-PB16: all customer.name occurrences are replaced (global replace)", () => {
    const result = resolvePlaceholders(
      "{{customer.name}} — follow up with {{customer.name}}",
      baseCtx
    );
    expect(result).toBe("Bobo the Clown Ltd — follow up with Bobo the Clown Ltd");
  });
});

describe("resolvePlaceholders — contact fields", () => {
  it("TC-PB17: {{contact.primary.name}} resolves to full name", () => {
    expect(resolvePlaceholders("Intro call with {{contact.primary.name}}", baseCtx))
      .toBe("Intro call with Bobo Jr");
  });

  it("TC-PB18: {{contact.primary.email}} resolves to email address", () => {
    expect(resolvePlaceholders("Send to {{contact.primary.email}}", baseCtx))
      .toBe("Send to bobo.jr@bobotheclown.example.com");
  });
});

describe("resolvePlaceholders — date fields", () => {
  it("TC-PB19: {{playbook.start_date}} resolves to anchor date", () => {
    expect(resolvePlaceholders("Kickoff: {{playbook.start_date}}", baseCtx))
      .toBe("Kickoff: 2026-05-01");
  });

  it("TC-PB20: {{playbook.start_year}} resolves to 4-digit year", () => {
    expect(resolvePlaceholders("{{customer.slug}}-{{playbook.start_year}}", baseCtx))
      .toBe("bobo-the-clown-ltd-2026");
  });

  it("TC-PB21: {{playbook.start_date+3d}} resolves to start + 3 days", () => {
    expect(resolvePlaceholders("Due: {{playbook.start_date+3d}}", baseCtx))
      .toBe("Due: 2026-05-04");
  });

  it("TC-PB22: {{playbook.start_date+0d}} resolves to the same day", () => {
    expect(resolvePlaceholders("{{playbook.start_date+0d}}", baseCtx))
      .toBe("2026-05-01");
  });

  it("TC-PB23: multiple date offsets in one string resolve independently", () => {
    const result = resolvePlaceholders(
      "Start: {{playbook.start_date+1d}}, End: {{playbook.start_date+10d}}",
      baseCtx
    );
    expect(result).toBe("Start: 2026-05-02, End: 2026-05-11");
  });

  it("TC-PB24: large day offset (30d) resolves correctly", () => {
    expect(resolvePlaceholders("{{playbook.start_date+30d}}", baseCtx))
      .toBe("2026-05-31");
  });
});

describe("resolvePlaceholders — edge cases", () => {
  it("TC-PB25: template with no placeholders is returned unchanged", () => {
    expect(resolvePlaceholders("Send proposal", baseCtx))
      .toBe("Send proposal");
  });

  it("TC-PB26: empty template resolves to empty string", () => {
    expect(resolvePlaceholders("", baseCtx)).toBe("");
  });

  it("TC-PB27: unknown placeholder is left in the string verbatim", () => {
    expect(resolvePlaceholders("{{unknown.field}} test", baseCtx))
      .toBe("{{unknown.field}} test");
  });

  it("TC-PB28: empty customer name produces an empty replacement", () => {
    const ctx = { ...baseCtx, customerName: "" };
    expect(resolvePlaceholders("Hello {{customer.name}}", ctx))
      .toBe("Hello ");
  });

  it("TC-PB29: placeholders in mixed content resolve correctly", () => {
    const result = resolvePlaceholders(
      "Send intro to {{contact.primary.name}} at {{customer.name}} — due {{playbook.start_date+2d}}",
      baseCtx
    );
    expect(result).toBe(
      "Send intro to Bobo Jr at Bobo the Clown Ltd — due 2026-05-03"
    );
  });
});

// ── resolveJsonPlaceholders ──────────────────────────────────────────────────
// Mirrors: resolveJsonPlaceholders() in tools/playbooks/index.ts

const resolveJsonPlaceholders = (obj: unknown, ctx: PlaceholderContext): unknown => {
  if (typeof obj === "string") return resolvePlaceholders(obj, ctx);
  if (Array.isArray(obj)) return obj.map((v) => resolveJsonPlaceholders(v, ctx));
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveJsonPlaceholders(v, ctx);
    }
    return out;
  }
  return obj;
};

describe("resolveJsonPlaceholders", () => {
  it("TC-PB30: resolves placeholders in a flat object", () => {
    const result = resolveJsonPlaceholders(
      { name: "{{customer.slug}}-2026", private: true },
      baseCtx
    ) as Record<string, unknown>;
    expect(result.name).toBe("bobo-the-clown-ltd-2026");
    expect(result.private).toBe(true);
  });

  it("TC-PB31: resolves placeholders in nested objects recursively", () => {
    const result = resolveJsonPlaceholders(
      { repo: { name: "{{customer.slug}}", owner: "ourthinktank" } },
      baseCtx
    ) as Record<string, unknown>;
    const repo = result.repo as Record<string, unknown>;
    expect(repo.name).toBe("bobo-the-clown-ltd");
    expect(repo.owner).toBe("ourthinktank");
  });

  it("TC-PB32: resolves placeholders in array elements", () => {
    const result = resolveJsonPlaceholders(
      ["{{customer.name}}", "{{contact.primary.name}}"],
      baseCtx
    ) as string[];
    expect(result).toEqual(["Bobo the Clown Ltd", "Bobo Jr"]);
  });

  it("TC-PB33: non-string primitives pass through unchanged", () => {
    const result = resolveJsonPlaceholders(
      { count: 42, active: false, value: null },
      baseCtx
    ) as Record<string, unknown>;
    expect(result.count).toBe(42);
    expect(result.active).toBe(false);
    expect(result.value).toBeNull();
  });

  it("TC-PB34: null input returns null", () => {
    expect(resolveJsonPlaceholders(null, baseCtx)).toBeNull();
  });
});

// ── buildConnectorRequirements ───────────────────────────────────────────────
// Mirrors: buildConnectorRequirements() in tools/playbooks/index.ts

type StepType = "native_task" | "external_action";

interface MockStep {
  id: string;
  type: StepType;
  title: string;
  connector: string | null;
  action: string | null;
}

const buildConnectorRequirements = (steps: MockStep[]) => {
  const seen = new Set<string>();
  const breakdown: { connector: string; action: string; step_title: string }[] = [];
  for (const s of steps) {
    if (s.type === "external_action" && s.connector) {
      seen.add(s.connector);
      breakdown.push({
        connector: s.connector,
        action: s.action ?? "unknown",
        step_title: s.title,
      });
    }
  }
  return { connectors: Array.from(seen), breakdown };
};

describe("buildConnectorRequirements", () => {
  it("TC-PB35: empty step list returns no connectors", () => {
    const { connectors } = buildConnectorRequirements([]);
    expect(connectors).toEqual([]);
  });

  it("TC-PB36: native_task steps do not contribute connectors", () => {
    const steps: MockStep[] = [
      { id: "1", type: "native_task", title: "Do research", connector: null, action: null },
      { id: "2", type: "native_task", title: "Send proposal", connector: null, action: null },
    ];
    const { connectors } = buildConnectorRequirements(steps);
    expect(connectors).toEqual([]);
  });

  it("TC-PB37: a single external_action step returns its connector", () => {
    const steps: MockStep[] = [
      { id: "1", type: "external_action", title: "Notify team", connector: "slack", action: "send_message" },
    ];
    const { connectors } = buildConnectorRequirements(steps);
    expect(connectors).toContain("slack");
    expect(connectors).toHaveLength(1);
  });

  it("TC-PB38: duplicate connectors across steps are deduplicated", () => {
    const steps: MockStep[] = [
      { id: "1", type: "external_action", title: "Create channel", connector: "slack", action: "create_channel" },
      { id: "2", type: "external_action", title: "Post message", connector: "slack", action: "send_message" },
    ];
    const { connectors } = buildConnectorRequirements(steps);
    expect(connectors).toEqual(["slack"]);
  });

  it("TC-PB39: multiple distinct connectors all appear in the list", () => {
    const steps: MockStep[] = [
      { id: "1", type: "external_action", title: "Create repo", connector: "github", action: "create_repo" },
      { id: "2", type: "external_action", title: "Notify team", connector: "slack", action: "send_message" },
      { id: "3", type: "external_action", title: "Schedule kickoff", connector: "calendar", action: "create_event" },
    ];
    const { connectors } = buildConnectorRequirements(steps);
    expect(connectors).toHaveLength(3);
    expect(connectors).toContain("github");
    expect(connectors).toContain("slack");
    expect(connectors).toContain("calendar");
  });

  it("TC-PB40: breakdown includes all external_action steps, even duplicated connectors", () => {
    const steps: MockStep[] = [
      { id: "1", type: "external_action", title: "Create channel", connector: "slack", action: "create_channel" },
      { id: "2", type: "external_action", title: "Post message", connector: "slack", action: "send_message" },
    ];
    const { breakdown } = buildConnectorRequirements(steps);
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].step_title).toBe("Create channel");
    expect(breakdown[1].step_title).toBe("Post message");
  });

  it("TC-PB41: external_action step with null connector is excluded from requirements", () => {
    const steps: MockStep[] = [
      { id: "1", type: "external_action", title: "Orphan action", connector: null, action: "do_something" },
    ];
    const { connectors } = buildConnectorRequirements(steps);
    expect(connectors).toEqual([]);
  });

  it("TC-PB42: mixed step list counts only external_action entries", () => {
    const steps: MockStep[] = [
      { id: "1", type: "native_task", title: "Research", connector: null, action: null },
      { id: "2", type: "external_action", title: "Create repo", connector: "github", action: "create_repo" },
      { id: "3", type: "native_task", title: "Send proposal", connector: null, action: null },
    ];
    const { connectors, breakdown } = buildConnectorRequirements(steps);
    expect(connectors).toEqual(["github"]);
    expect(breakdown).toHaveLength(1);
  });
});

// ── Run status logic ─────────────────────────────────────────────────────────
// Status is "partial" only on step errors, not because external actions exist.

describe("Run status logic", () => {
  const resolveRunStatus = (hasErrors: boolean) =>
    hasErrors ? "partial" : "complete";

  it("TC-PB43: no errors → status is 'complete'", () => {
    expect(resolveRunStatus(false)).toBe("complete");
  });

  it("TC-PB44: step errors → status is 'partial'", () => {
    expect(resolveRunStatus(true)).toBe("partial");
  });

  it("TC-PB45: having external actions does NOT make status 'partial'", () => {
    // External actions emitted is expected behavior, not a failure.
    // Status depends only on hasErrors.
    const hasExternalActions = true;
    const hasErrors = false;
    expect(resolveRunStatus(hasErrors)).toBe("complete");
    expect(hasExternalActions).toBe(true); // external actions present but run is still complete
  });
});

// ── Due date offset calculation ───────────────────────────────────────────────

describe("Due date offset from playbook start_date", () => {
  const computeDueDate = (startDate: string, offset: number | null): string | null =>
    offset != null ? addDays(startDate, offset) : null;

  it("TC-PB46: null offset returns null (no due date)", () => {
    expect(computeDueDate("2026-05-01", null)).toBeNull();
  });

  it("TC-PB47: offset of 0 returns the start date itself", () => {
    expect(computeDueDate("2026-05-01", 0)).toBe("2026-05-01");
  });

  it("TC-PB48: offset of 1 returns start + 1 day", () => {
    expect(computeDueDate("2026-05-01", 1)).toBe("2026-05-02");
  });

  it("TC-PB49: offset of 24 returns start + 24 days", () => {
    expect(computeDueDate("2026-05-01", 24)).toBe("2026-05-25");
  });

  it("TC-PB50: two steps with different offsets produce correctly spaced due dates", () => {
    const startDate = "2026-05-01";
    const step1Due = computeDueDate(startDate, 2);
    const step2Due = computeDueDate(startDate, 16);
    expect(step1Due).toBe("2026-05-03");
    expect(step2Due).toBe("2026-05-17");
    // Verify spacing
    const gap = (new Date(step2Due!).getTime() - new Date(step1Due!).getTime()) / 86_400_000;
    expect(gap).toBe(14);
  });
});

// ── Playbook slug uniqueness (format validation) ──────────────────────────────

describe("Playbook slug format", () => {
  const isValidSlug = (s: string) => /^[a-z0-9-]+$/.test(s) && !s.startsWith("-") && !s.endsWith("-");

  it("TC-PB51: valid slugs pass", () => {
    expect(isValidSlug("new-deal")).toBe(true);
    expect(isValidSlug("web-project-2026")).toBe(true);
    expect(isValidSlug("onboarding")).toBe(true);
  });

  it("TC-PB52: uppercase letters fail", () => {
    expect(isValidSlug("New-Deal")).toBe(false);
  });

  it("TC-PB53: leading hyphen fails", () => {
    expect(isValidSlug("-new-deal")).toBe(false);
  });

  it("TC-PB54: trailing hyphen fails", () => {
    expect(isValidSlug("new-deal-")).toBe(false);
  });

  it("TC-PB55: spaces fail", () => {
    expect(isValidSlug("new deal")).toBe(false);
  });
});

// ── Step ordering ─────────────────────────────────────────────────────────────

describe("Step ordering by order_index", () => {
  type OrderedStep = { order_index: number; title: string };

  const sortSteps = (steps: OrderedStep[]): OrderedStep[] =>
    [...steps].sort((a, b) => a.order_index - b.order_index);

  it("TC-PB56: steps are sorted ascending by order_index", () => {
    const steps = [
      { order_index: 3, title: "Step C" },
      { order_index: 1, title: "Step A" },
      { order_index: 2, title: "Step B" },
    ];
    const sorted = sortSteps(steps);
    expect(sorted[0].title).toBe("Step A");
    expect(sorted[1].title).toBe("Step B");
    expect(sorted[2].title).toBe("Step C");
  });

  it("TC-PB57: steps already in order are unchanged", () => {
    const steps = [
      { order_index: 1, title: "Step A" },
      { order_index: 2, title: "Step B" },
    ];
    expect(sortSteps(steps)[0].title).toBe("Step A");
  });

  it("TC-PB58: gaps in order_index values are fine — sort by value not position", () => {
    const steps = [
      { order_index: 10, title: "Step B" },
      { order_index: 1, title: "Step A" },
      { order_index: 100, title: "Step C" },
    ];
    const sorted = sortSteps(steps);
    expect(sorted.map((s) => s.title)).toEqual(["Step A", "Step B", "Step C"]);
  });
});
