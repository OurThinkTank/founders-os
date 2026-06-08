// ============================================================
// Tests for restore.ts - pure logic functions
// ============================================================
// All tests here mirror logic that lives in restore.ts and run
// without a Supabase connection. The functions tested are:
//   isDemoFixture, toDeletedItem, deletedSelect, hasBatchFilter,
//   countByType, PURGE_RANK, RESTORE_CONFIG
//
// Source-reading tests (TC-RST-SRC-*) verify the actual file
// rather than an inline copy, acting as regression guards that
// catch silent data drift in the config constants.
// ============================================================
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "../tools");

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(toolsDir, relPath), "utf8");
}

// ── Types (mirrored from restore.ts) ────────────────────────

type RestorableEntity =
  | "customer"
  | "contact"
  | "interaction"
  | "task"
  | "tag"
  | "playbook"
  | "playbook_step"
  | "project"
  | "financial_account"
  | "financial_category"
  | "financial_transaction";

interface DeletedItem {
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
  deleted_at: string;
  tags?: string[];
  parent_name?: string;
}

// ── isDemoFixture (mirrored from restore.ts) ─────────────────

const RESTORE_CONFIG_labelColumn: Record<RestorableEntity, string> = {
  customer: "organization_name",
  contact: "first_name",
  interaction: "subject",
  task: "title",
  tag: "name",
  playbook: "name",
  playbook_step: "title",
  project: "name",
  financial_account: "name",
  financial_category: "name",
  financial_transaction: "description",
};

function isDemoFixture(item: DeletedItem): boolean {
  const looksDemo = (s: string | undefined): boolean =>
    !!s && (/\(demo[\s)]/i.test(s) || /^demo[:\s-]/i.test(s));
  if (looksDemo(item.label) || looksDemo(item.parent_name)) return true;
  if (
    item.entity_type === "tag" &&
    (/^demorun-/.test(item.label) || /^demo-/.test(item.label) || /^__.*__$/.test(item.label))
  ) {
    return true;
  }
  if (
    item.tags?.some(
      (t) => typeof t === "string" && (/^demorun-/.test(t) || /^demo-/.test(t))
    )
  ) {
    return true;
  }
  return false;
}

// ── toDeletedItem (mirrored from restore.ts) ─────────────────

function toDeletedItem(type: RestorableEntity, row: Record<string, unknown>): DeletedItem {
  const id = row.id as string;
  let label: string;
  let parent_name: string | undefined;
  if (type === "contact") {
    label = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || id;
    parent_name = (row.customers as { organization_name?: string } | null)?.organization_name;
  } else if (type === "interaction") {
    label = (row.subject as string) ?? id;
    parent_name = (row.customers as { organization_name?: string } | null)?.organization_name;
  } else {
    label = (row[RESTORE_CONFIG_labelColumn[type]] as string) ?? id;
  }
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : undefined;
  return { entity_type: type, entity_id: id, label, deleted_at: row.deleted_at as string, tags, parent_name };
}

// ── deletedSelect (mirrored from restore.ts) ─────────────────

const TYPES_WITH_TAGS = new Set<RestorableEntity>([
  "customer",
  "task",
  "financial_account",
  "financial_category",
  "financial_transaction",
]);

function deletedSelect(type: RestorableEntity): string {
  if (type === "contact")
    return "id, deleted_at, first_name, last_name, customers!inner(company_id, organization_name)";
  if (type === "interaction")
    return "id, deleted_at, subject, customers!inner(company_id, organization_name)";
  if (type === "playbook_step")
    return "id, deleted_at, title, playbooks!inner(company_id)";
  const cols = ["id", "deleted_at", RESTORE_CONFIG_labelColumn[type]];
  if (TYPES_WITH_TAGS.has(type)) cols.push("tags");
  return cols.join(", ");
}

// ── hasBatchFilter (mirrored from restore.ts) ─────────────────

interface BatchSelect {
  items?: { entity_type: RestorableEntity; entity_id: string }[];
  entity_type?: RestorableEntity;
  older_than_days?: number;
  only_demo?: boolean;
  all?: boolean;
  days?: number;
}

function hasBatchFilter(p: BatchSelect): boolean {
  return Boolean(p.all || p.only_demo || p.entity_type || p.older_than_days != null);
}

// ── countByType (mirrored from restore.ts) ─────────────────

interface BatchTarget {
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
}

function countByType(targets: BatchTarget[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) {
    const k = t.entity_type.replace(/_/g, " ");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ============================================================
// Test suites
// ============================================================

// ── isDemoFixture ────────────────────────────────────────────

describe("isDemoFixture — label patterns", () => {
  const makeItem = (label: string, type: RestorableEntity = "customer"): DeletedItem => ({
    entity_type: type,
    entity_id: "abc",
    label,
    deleted_at: "2025-01-01T00:00:00Z",
  });

  it("TC-RST01: '(demo abc)' suffix marks as demo", () => {
    expect(isDemoFixture(makeItem("Acme Corp (demo abc123)"))).toBe(true);
  });

  it("TC-RST02: '(demo)' with no run id marks as demo", () => {
    expect(isDemoFixture(makeItem("Widget Co (demo)"))).toBe(true);
  });

  it("TC-RST03: 'Demo: ' prefix marks as demo (case insensitive)", () => {
    expect(isDemoFixture(makeItem("Demo: Seed Customer"))).toBe(true);
    expect(isDemoFixture(makeItem("demo: Seed Customer"))).toBe(true);
  });

  it("TC-RST04: 'Demo ' prefix (space, no colon) marks as demo", () => {
    expect(isDemoFixture(makeItem("Demo Customer Alpha"))).toBe(true);
  });

  it("TC-RST05: 'Demo-' prefix marks as demo", () => {
    expect(isDemoFixture(makeItem("Demo-Acme"))).toBe(true);
  });

  it("TC-RST06: plain customer name is not a demo fixture", () => {
    expect(isDemoFixture(makeItem("Acme Corp"))).toBe(false);
  });

  it("TC-RST07: 'democracy' does not trigger demo match (no separator)", () => {
    // The regex requires a space or ) after 'demo' in parens, or a separator after the prefix
    expect(isDemoFixture(makeItem("democracy software"))).toBe(false);
  });

  it("TC-RST08: parent_name matching triggers demo detection", () => {
    const item: DeletedItem = {
      entity_type: "contact",
      entity_id: "xyz",
      label: "Jane Smith",
      deleted_at: "2025-01-01T00:00:00Z",
      parent_name: "Acme Corp (demo abc)",
    };
    expect(isDemoFixture(item)).toBe(true);
  });

  it("TC-RST09: normal parent_name does not trigger demo detection", () => {
    const item: DeletedItem = {
      entity_type: "contact",
      entity_id: "xyz",
      label: "Jane Smith",
      deleted_at: "2025-01-01T00:00:00Z",
      parent_name: "Acme Corp",
    };
    expect(isDemoFixture(item)).toBe(false);
  });
});

describe("isDemoFixture — tag-based detection", () => {
  const makeTagged = (tags: string[], type: RestorableEntity = "customer"): DeletedItem => ({
    entity_type: type,
    entity_id: "abc",
    label: "Normal Name",
    deleted_at: "2025-01-01T00:00:00Z",
    tags,
  });

  it("TC-RST10: demorun- prefixed tag marks as demo", () => {
    expect(isDemoFixture(makeTagged(["demorun-a1b2c3", "other-tag"]))).toBe(true);
  });

  it("TC-RST11: demo- prefixed tag marks as demo", () => {
    expect(isDemoFixture(makeTagged(["demo-seed", "normal"]))).toBe(true);
  });

  it("TC-RST12: unrelated tags do not trigger detection", () => {
    expect(isDemoFixture(makeTagged(["priority-high", "q1"]))).toBe(false);
  });

  it("TC-RST13: empty tags array does not trigger detection", () => {
    expect(isDemoFixture(makeTagged([]))).toBe(false);
  });
});

describe("isDemoFixture — tag entity special cases", () => {
  const makeTag = (label: string): DeletedItem => ({
    entity_type: "tag",
    entity_id: "t1",
    label,
    deleted_at: "2025-01-01T00:00:00Z",
  });

  it("TC-RST14: demorun- prefixed tag label marks as demo", () => {
    expect(isDemoFixture(makeTag("demorun-abc123"))).toBe(true);
  });

  it("TC-RST15: demo- prefixed tag label marks as demo", () => {
    expect(isDemoFixture(makeTag("demo-seed-tag"))).toBe(true);
  });

  it("TC-RST16: __marker__ style tag label marks as demo", () => {
    expect(isDemoFixture(makeTag("__demo_run__"))).toBe(true);
  });

  it("TC-RST17: normal tag label is not a demo fixture", () => {
    expect(isDemoFixture(makeTag("priority"))).toBe(false);
  });

  it("TC-RST18: __marker__ check only applies to tag entity type", () => {
    const item: DeletedItem = {
      entity_type: "customer",
      entity_id: "c1",
      label: "__demo_run__",
      deleted_at: "2025-01-01T00:00:00Z",
    };
    // Customer label __demo_run__ does not match demo prefix/suffix patterns
    expect(isDemoFixture(item)).toBe(false);
  });
});

// ── toDeletedItem ────────────────────────────────────────────

describe("toDeletedItem — contact label assembly", () => {
  it("TC-RST19: assembles first + last name into label", () => {
    const row = {
      id: "c1",
      first_name: "Jane",
      last_name: "Smith",
      deleted_at: "2025-01-01T00:00:00Z",
      customers: { organization_name: "Acme Corp", company_id: "co1" },
    };
    const item = toDeletedItem("contact", row);
    expect(item.label).toBe("Jane Smith");
  });

  it("TC-RST20: falls back to id when both name fields are absent", () => {
    const row = { id: "c1", deleted_at: "2025-01-01T00:00:00Z", customers: null };
    const item = toDeletedItem("contact", row);
    expect(item.label).toBe("c1");
  });

  it("TC-RST21: populates parent_name from customers join", () => {
    const row = {
      id: "c1",
      first_name: "Jane",
      last_name: "Smith",
      deleted_at: "2025-01-01T00:00:00Z",
      customers: { organization_name: "Acme Corp", company_id: "co1" },
    };
    const item = toDeletedItem("contact", row);
    expect(item.parent_name).toBe("Acme Corp");
  });

  it("TC-RST22: parent_name is undefined when customers join is null", () => {
    const row = {
      id: "c1",
      first_name: "Jane",
      last_name: "",
      deleted_at: "2025-01-01T00:00:00Z",
      customers: null,
    };
    const item = toDeletedItem("contact", row);
    expect(item.parent_name).toBeUndefined();
  });
});

describe("toDeletedItem — interaction label assembly", () => {
  it("TC-RST23: uses subject as label", () => {
    const row = {
      id: "i1",
      subject: "Discovery call",
      deleted_at: "2025-01-01T00:00:00Z",
      customers: { organization_name: "Acme Corp" },
    };
    const item = toDeletedItem("interaction", row);
    expect(item.label).toBe("Discovery call");
  });

  it("TC-RST24: falls back to id when subject is absent", () => {
    const row = { id: "i1", deleted_at: "2025-01-01T00:00:00Z", customers: null };
    const item = toDeletedItem("interaction", row);
    expect(item.label).toBe("i1");
  });
});

describe("toDeletedItem — generic entity label", () => {
  it("TC-RST25: uses labelColumn value for customer", () => {
    const row = {
      id: "cu1",
      organization_name: "Widget Co",
      deleted_at: "2025-01-01T00:00:00Z",
    };
    const item = toDeletedItem("customer", row);
    expect(item.label).toBe("Widget Co");
  });

  it("TC-RST26: uses labelColumn value for task (title)", () => {
    const row = { id: "t1", title: "Ship feature", deleted_at: "2025-01-01T00:00:00Z" };
    const item = toDeletedItem("task", row);
    expect(item.label).toBe("Ship feature");
  });

  it("TC-RST27: tags array is included when present", () => {
    const row = {
      id: "cu1",
      organization_name: "Widget Co",
      deleted_at: "2025-01-01T00:00:00Z",
      tags: ["demo-seed", "q1"],
    };
    const item = toDeletedItem("customer", row);
    expect(item.tags).toEqual(["demo-seed", "q1"]);
  });

  it("TC-RST28: tags is undefined when row has no tags field", () => {
    const row = {
      id: "cu1",
      organization_name: "Widget Co",
      deleted_at: "2025-01-01T00:00:00Z",
    };
    const item = toDeletedItem("customer", row);
    expect(item.tags).toBeUndefined();
  });

  it("TC-RST29: tags is undefined when row.tags is not an array", () => {
    const row = {
      id: "cu1",
      organization_name: "Widget Co",
      deleted_at: "2025-01-01T00:00:00Z",
      tags: "not-an-array",
    };
    const item = toDeletedItem("customer", row);
    expect(item.tags).toBeUndefined();
  });

  it("TC-RST30: entity_id is always set to row.id", () => {
    const row = { id: "proj1", name: "Alpha", deleted_at: "2025-01-01T00:00:00Z" };
    const item = toDeletedItem("project", row);
    expect(item.entity_id).toBe("proj1");
    expect(item.entity_type).toBe("project");
  });
});

// ── deletedSelect ────────────────────────────────────────────

describe("deletedSelect — per-type SELECT strings", () => {
  it("TC-RST31: contact includes join to customers with organization_name", () => {
    const s = deletedSelect("contact");
    expect(s).toContain("first_name");
    expect(s).toContain("last_name");
    expect(s).toContain("customers!inner(company_id, organization_name)");
  });

  it("TC-RST32: interaction includes join to customers with organization_name", () => {
    const s = deletedSelect("interaction");
    expect(s).toContain("subject");
    expect(s).toContain("customers!inner(company_id, organization_name)");
  });

  it("TC-RST33: playbook_step includes join to playbooks", () => {
    const s = deletedSelect("playbook_step");
    expect(s).toContain("title");
    expect(s).toContain("playbooks!inner(company_id)");
  });

  it("TC-RST34: customer includes tags column", () => {
    const s = deletedSelect("customer");
    expect(s).toContain("tags");
    expect(s).toContain("organization_name");
  });

  it("TC-RST35: task includes tags column", () => {
    const s = deletedSelect("task");
    expect(s).toContain("tags");
    expect(s).toContain("title");
  });

  it("TC-RST36: playbook does not include tags (no tags column on table)", () => {
    const s = deletedSelect("playbook");
    expect(s).not.toContain("tags");
    expect(s).toContain("name");
  });

  it("TC-RST37: project does not include tags column", () => {
    const s = deletedSelect("project");
    expect(s).not.toContain("tags");
    expect(s).toContain("name");
  });

  it("TC-RST38: all selects include id and deleted_at", () => {
    const types: RestorableEntity[] = [
      "customer", "contact", "interaction", "task", "tag",
      "playbook", "playbook_step", "project",
      "financial_account", "financial_category", "financial_transaction",
    ];
    for (const t of types) {
      const s = deletedSelect(t);
      expect(s).toContain("id");
      expect(s).toContain("deleted_at");
    }
  });
});

// ── hasBatchFilter ────────────────────────────────────────────

describe("hasBatchFilter — batch filter detection", () => {
  it("TC-RST39: empty object returns false", () => {
    expect(hasBatchFilter({})).toBe(false);
  });

  it("TC-RST40: items-only list returns false (not a filter)", () => {
    expect(hasBatchFilter({ items: [{ entity_type: "task", entity_id: "abc" }] })).toBe(false);
  });

  it("TC-RST41: all=true returns true", () => {
    expect(hasBatchFilter({ all: true })).toBe(true);
  });

  it("TC-RST42: only_demo=true returns true", () => {
    expect(hasBatchFilter({ only_demo: true })).toBe(true);
  });

  it("TC-RST43: entity_type set returns true", () => {
    expect(hasBatchFilter({ entity_type: "task" })).toBe(true);
  });

  it("TC-RST44: older_than_days=0 returns true (0 is a valid filter, not null)", () => {
    expect(hasBatchFilter({ older_than_days: 0 })).toBe(true);
  });

  it("TC-RST45: older_than_days=undefined returns false", () => {
    expect(hasBatchFilter({ older_than_days: undefined })).toBe(false);
  });

  it("TC-RST46: only days set (not a filter flag) returns false", () => {
    // days controls the lookback window, not the filter toggle
    expect(hasBatchFilter({ days: 30 })).toBe(false);
  });
});

// ── countByType ──────────────────────────────────────────────

describe("countByType — batch target counting", () => {
  it("TC-RST47: empty array returns empty object", () => {
    expect(countByType([])).toEqual({});
  });

  it("TC-RST48: single type returns count of 1", () => {
    const targets: BatchTarget[] = [{ entity_type: "task", entity_id: "t1", label: "T1" }];
    expect(countByType(targets)).toEqual({ task: 1 });
  });

  it("TC-RST49: multiple items of same type accumulate", () => {
    const targets: BatchTarget[] = [
      { entity_type: "task", entity_id: "t1", label: "T1" },
      { entity_type: "task", entity_id: "t2", label: "T2" },
      { entity_type: "task", entity_id: "t3", label: "T3" },
    ];
    expect(countByType(targets)).toEqual({ task: 3 });
  });

  it("TC-RST50: mixed types are counted independently", () => {
    const targets: BatchTarget[] = [
      { entity_type: "task", entity_id: "t1", label: "T1" },
      { entity_type: "customer", entity_id: "c1", label: "C1" },
      { entity_type: "task", entity_id: "t2", label: "T2" },
    ];
    const result = countByType(targets);
    expect(result.task).toBe(2);
    expect(result.customer).toBe(1);
  });

  it("TC-RST51: underscores in entity_type are replaced with spaces", () => {
    const targets: BatchTarget[] = [
      { entity_type: "financial_transaction", entity_id: "f1", label: "F1" },
      { entity_type: "playbook_step", entity_id: "p1", label: "P1" },
    ];
    const result = countByType(targets);
    expect(result["financial transaction"]).toBe(1);
    expect(result["playbook step"]).toBe(1);
    expect(result["financial_transaction"]).toBeUndefined();
  });
});

// ── PURGE_RANK (source-reading guard) ────────────────────────

describe("PURGE_RANK — ordering guard (source-reading)", () => {
  const src = readSource("restore.ts");

  it("TC-RST-SRC01: interaction has rank 0 (purged first, as child of customers)", () => {
    expect(src).toMatch(/interaction:\s*0/);
  });

  it("TC-RST-SRC02: contact has rank 1 (after interaction)", () => {
    expect(src).toMatch(/contact:\s*1/);
  });

  it("TC-RST-SRC03: playbook_step has rank 2 (after contact, before task)", () => {
    expect(src).toMatch(/playbook_step:\s*2/);
  });

  it("TC-RST-SRC04: task, tag, financial_transaction share rank 3", () => {
    // All three are leaves with no shared FK constraints between them
    expect(src).toMatch(/task:\s*3/);
    expect(src).toMatch(/\btag:\s*3/);
    expect(src).toMatch(/financial_transaction:\s*3/);
  });

  it("TC-RST-SRC05: financial_category and financial_account share rank 4", () => {
    expect(src).toMatch(/financial_category:\s*4/);
    expect(src).toMatch(/financial_account:\s*4/);
  });

  it("TC-RST-SRC06: project has rank 5", () => {
    expect(src).toMatch(/project:\s*5/);
  });

  it("TC-RST-SRC07: playbook has rank 6 (before customer)", () => {
    expect(src).toMatch(/\bplaybook:\s*6/);
  });

  it("TC-RST-SRC08: customer has rank 7 (purged last, as top-level parent)", () => {
    expect(src).toMatch(/customer:\s*7/);
  });
});

// ── RESTORE_CONFIG spot checks (source-reading guard) ────────

describe("RESTORE_CONFIG — table names and special values (source-reading)", () => {
  const src = readSource("restore.ts");

  it("TC-RST-SRC09: customer maps to customers table with customer_phase archive column", () => {
    expect(src).toContain("table: \"customers\"");
    expect(src).toContain("archiveColumn: \"customer_phase\"");
    expect(src).toContain("archivedValue: \"inactive\"");
    expect(src).toContain("activeValue: \"lead\"");
  });

  it("TC-RST-SRC10: task uses __notnull__ sentinel for archived_at (not a literal value)", () => {
    // archived_at IS NOT NULL means archived; restoreOne handles this case specially
    expect(src).toContain("archivedValue: \"__notnull__\"");
  });

  it("TC-RST-SRC11: interaction uses __never__ sentinel (soft-delete only, no archive state)", () => {
    expect(src).toContain("archivedValue: \"__never__\"");
    expect(src).toContain("softDeleteOnly: true");
  });

  it("TC-RST-SRC12: financial_transaction uses the correct table name (not transactions)", () => {
    // Guard: wrong table name is one of the DB checklist items in the PR template
    expect(src).toContain("table: \"financial_transactions\"");
    expect(src).not.toMatch(/table:\s*["']transactions["']/);
  });

  it("TC-RST-SRC13: tag maps to tag_registry table", () => {
    expect(src).toContain("table: \"tag_registry\"");
  });

  it("TC-RST-SRC14: contact uses is_active boolean archive column", () => {
    expect(src).toContain("archiveColumn: \"is_active\"");
    expect(src).toContain("archivedValue: false");
    expect(src).toContain("activeValue: true");
  });

  it("TC-RST-SRC15: project uses status column with archived/active string values", () => {
    expect(src).toContain("archivedValue: \"archived\"");
    expect(src).toContain("activeValue: \"active\"");
  });

  it("TC-RST-SRC16: task scope is 'check' (personal tasks need creator verification)", () => {
    expect(src).toContain("scope: \"check\"");
    expect(src).toContain("scopeColumn: \"scope\"");
    expect(src).toContain("createdByColumn: \"created_by\"");
  });
});
