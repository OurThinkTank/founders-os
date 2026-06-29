// ============================================================
// Founders OS regression tests
//
// Source-reading regression guards for bugs that have been fixed.
// Each test reads the actual TypeScript source and asserts the fix
// is present. If a fix is accidentally reverted, the test fails.
//
// Bugs covered:
//   2022-01  get_customer must not query the dropped follow_ups table
//   2022-02  rename_tag_in_customers must scope by company_id
//   2022-03  list_customers must use open_tasks not open_follow_ups
//   2022-04  get_dashboard must scope all queries to company_id
//   BUG-01   get_entity_card must query financial_transactions
//   NEW-01   get_task_summary must use timezone-aware date helpers
//   NEW-02   validateTags contact/customer lookups must scope to company_id
//   NEW-03   list_entity_tasks tasks query must include company_id
//   BUG-02a  update_task UPDATE must include company_id guard
//   BUG-02b  complete_task UPDATE must include company_id guard
//   BUG-03a  remove_tag soft-delete must scope to company_id
//   BUG-03b  rename_tag registry UPDATE must scope to company_id
//   2022-06a get_task primary SELECT must include company_id
//   2022-06b assign_task UPDATE must include company_id
//   BUG-04   transfer_between_accounts must reject same-account transfers
//   NEW-04   add_account must reject negative initial_balance
//   NEW-05   complete_task must return already_done:true when already done
//   NEW-06   get_stuck_list overdue query must include in_progress status
//   NEW-08   get_financial_summary must use getUTCFullYear not getFullYear
//   2022-07  memory_forget must check created_by for org memories
// ============================================================

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = path.resolve(__dirname, "../tools");
const supabaseDir = path.resolve(__dirname, "../../../../supabase");

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(toolsDir, relPath), "utf8");
}

// ── 2022-01: get_customer must not query the dropped follow_ups table ────────

describe("2022-01 get_customer — must not query dropped follow_ups table", () => {
  it("customers.ts must not contain supabase.from(\"follow_ups\")", () => {
    const source = readSource("crm/customers.ts");
    expect(source).not.toContain('from("follow_ups")');
  });

  it("customers.ts must not reference followUpsRes", () => {
    const source = readSource("crm/customers.ts");
    expect(source).not.toContain("followUpsRes");
  });
});

// ── 2022-02: rename_tag_in_customers must scope by company_id ────────────────

describe("2022-02 rename_tag_in_customers — must filter by company_id", () => {
  it("setup.sql customers table must define company_id column", () => {
    const setupPath = path.join(supabaseDir, "setup.sql");
    const sql = fs.readFileSync(setupPath, "utf8");
    const createStart = sql.indexOf("create table customers");
    const createEnd = sql.indexOf(");", createStart);
    const createBlock = sql.slice(createStart, createEnd);
    expect(createBlock).toContain("company_id");
  });

  it("setup.sql rename_tag_in_customers must filter by company_id", () => {
    const setupPath = path.join(supabaseDir, "setup.sql");
    const sql = fs.readFileSync(setupPath, "utf8");
    const fnStart = sql.indexOf("create or replace function rename_tag_in_customers");
    const fnEnd = sql.indexOf("$$ language plpgsql", fnStart) + 20;
    const fnBody = sql.slice(fnStart, fnEnd);
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnBody).toContain("company_id = p_company_id");
  });
});

// ── 2022-03: list_customers must use open_tasks column ──────────────────────

describe("2022-03 list_customers — must query open_tasks not open_follow_ups", () => {
  it("customers.ts must not use \"open_follow_ups\" as a column filter", () => {
    const source = readSource("crm/customers.ts");
    expect(source).not.toContain('"open_follow_ups"');
  });

  it("customers.ts has_open_follow_ups handler must use open_tasks column", () => {
    const source = readSource("crm/customers.ts");
    expect(source).toContain('.gt("open_tasks"');
  });
});

// ── 2022-04: get_dashboard must scope all queries to company_id ──────────────
//
// After the ToolContext refactor (2026-05-28), dashboard.ts references
// `ctx.companyId` instead of calling `getCompanyId()` directly. The
// regression check still holds: the file must use SOMETHING that names
// a company-scoped identifier, and every query must carry an
// `.eq("company_id", ...)` filter.

describe("2022-04 get_dashboard — must scope queries to company_id", () => {
  it("dashboard.ts must reference a company_id source (ctx.companyId or getCompanyId)", () => {
    const source = readSource("crm/dashboard.ts");
    expect(
      source.includes("ctx.companyId") || source.includes("getCompanyId")
    ).toBe(true);
  });

  it("dashboard.ts queries must include .eq('company_id', ...) filter", () => {
    const source = readSource("crm/dashboard.ts");
    expect(source).toContain('eq("company_id"');
  });
});

// ── BUG-01: get_entity_card must query financial_transactions ────────────────

describe("BUG-01 get_entity_card — must query financial_transactions not transactions", () => {
  it("surfaces/index.ts must not use .from(\"transactions\") for financial lookup", () => {
    const source = readSource("surfaces/index.ts");
    expect(source).not.toContain('.from("transactions")');
  });

  it("surfaces/index.ts transaction branch must reference financial_transactions", () => {
    const source = readSource("surfaces/index.ts");
    const branchStart = source.indexOf('entity_type === "transaction"');
    expect(branchStart).toBeGreaterThan(-1);
    const branchRegion = source.slice(branchStart, branchStart + 1500);
    expect(branchRegion).toContain("financial_transactions");
  });
});

// ── NEW-01: get_task_summary must use timezone-aware date helpers ─────────────

describe("NEW-01 get_task_summary — must use getLocalDateStr(timezone)", () => {
  it("tasks/index.ts get_task_summary must not use bare getToday() for today", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("get_task_summary:");
    const handlerBody = source.slice(handlerStart, handlerStart + 2000);
    expect(handlerBody).not.toContain("getToday()");
  });

  it("tasks/index.ts get_task_summary must not call getLocalDateStr(undefined, ...)", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("get_task_summary:");
    const handlerBody = source.slice(handlerStart, handlerStart + 2000);
    expect(handlerBody).not.toContain("getLocalDateStr(undefined,");
    expect(handlerBody).not.toContain("getLocalDateStr(undefined, ");
  });
});

// ── NEW-02: validateTags lookups must scope to company_id ────────────────────

describe("NEW-02 validateTags — contact and customer queries must include company_id", () => {
  it("tags/index.ts validateTags contacts query must be scoped to company_id", () => {
    const source = readSource("tags/index.ts");
    const fnStart = source.indexOf("export async function validateTags");
    const fnBody = source.slice(fnStart, fnStart + 1500);
    const contactsQueryIdx = fnBody.indexOf('from("contacts")');
    expect(contactsQueryIdx).toBeGreaterThan(-1);
    const afterContacts = fnBody.slice(contactsQueryIdx, contactsQueryIdx + 200);
    expect(afterContacts).toContain("company_id");
  });

  it("tags/index.ts validateTags customers query must be scoped to company_id", () => {
    const source = readSource("tags/index.ts");
    const fnStart = source.indexOf("export async function validateTags");
    const fnBody = source.slice(fnStart, fnStart + 1500);
    const customersQueryIdx = fnBody.indexOf('from("customers")');
    expect(customersQueryIdx).toBeGreaterThan(-1);
    const afterCustomers = fnBody.slice(customersQueryIdx, customersQueryIdx + 200);
    expect(afterCustomers).toContain("company_id");
  });
});

// ── NEW-03: list_entity_tasks tasks query must include company_id ─────────────

describe("NEW-03 list_entity_tasks — tasks query must include company_id", () => {
  it("tasks/index.ts list_entity_tasks tasks fetch must scope to company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("list_entity_tasks:");
    // Window covers params block + handler. Bumped from 1500 to 2500
    // after the BUG-05 work added `const companyId = getCompanyId();` and
    // an extra .eq() to the task_links read inside the same handler.
    const handlerBody = source.slice(handlerStart, handlerStart + 2500);
    const tasksQueryIdx = handlerBody.indexOf('.from("tasks")');
    expect(tasksQueryIdx).toBeGreaterThan(-1);
    const tasksQueryRegion = handlerBody.slice(tasksQueryIdx, tasksQueryIdx + 300);
    expect(tasksQueryRegion).toContain("company_id");
  });
});

// ── BUG-02a: update_task UPDATE must include company_id guard ────────────────

describe("BUG-02a update_task — UPDATE must include company_id guard", () => {
  it("tasks/index.ts update_task UPDATE query must include company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("update_task:");
    const handlerBody = source.slice(handlerStart, handlerStart + 5000);
    const updateIdx = handlerBody.indexOf(".update(updates)");
    expect(updateIdx).toBeGreaterThan(-1);
    const updateRegion = handlerBody.slice(updateIdx, updateIdx + 200);
    expect(updateRegion).toContain("company_id");
  });
});

// ── BUG-02b: complete_task UPDATE must include company_id guard ──────────────

describe("BUG-02b complete_task — UPDATE must include company_id guard", () => {
  it("tasks/index.ts complete_task UPDATE query must include company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("complete_task:");
    const handlerBody = source.slice(handlerStart, handlerStart + 4000);
    const updateIdx = handlerBody.indexOf(".update({");
    expect(updateIdx).toBeGreaterThan(-1);
    const updateRegion = handlerBody.slice(updateIdx, updateIdx + 200);
    expect(updateRegion).toContain("company_id");
  });
});

// ── BUG-03a: remove_tag soft-delete must scope to company_id ─────────────────

describe("BUG-03a remove_tag — soft-delete must scope to company_id", () => {
  it("tags/index.ts remove_tag sets deleted_at scoped to company_id", () => {
    const source = readSource("tags/index.ts");
    const handlerStart = source.indexOf("remove_tag:");
    expect(handlerStart).toBeGreaterThan(-1);
    const handlerBody = source.slice(handlerStart, handlerStart + 8000);
    const deleteIdx = handlerBody.indexOf("deleted_at:");
    expect(deleteIdx).toBeGreaterThan(-1);
    const deleteRegion = handlerBody.slice(deleteIdx, deleteIdx + 200);
    expect(deleteRegion).toContain("company_id");
  });
});

// ── BUG-03b: rename_tag registry UPDATE must scope to company_id ─────────────

describe("BUG-03b rename_tag — registry UPDATE must scope to company_id", () => {
  it("tags/index.ts rename_tag registry UPDATE must include company_id", () => {
    const source = readSource("tags/index.ts");
    const handlerStart = source.indexOf("rename_tag:");
    const handlerBody = source.slice(handlerStart, handlerStart + 6000);
    const updateIdx = handlerBody.indexOf('.from("tag_registry")\n        .update(');
    const updateIdx2 = handlerBody.indexOf('.from("tag_registry").update(');
    const foundIdx = updateIdx > -1 ? updateIdx : updateIdx2;
    expect(foundIdx).toBeGreaterThan(-1);
    const updateRegion = handlerBody.slice(foundIdx, foundIdx + 200);
    expect(updateRegion).toContain("company_id");
  });
});

// ── 2022-06a: get_task SELECT must include company_id ────────────────────────

describe("2022-06a get_task — SELECT must include company_id guard", () => {
  it("tasks/index.ts get_task primary SELECT must scope to company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("// get_task\n  // ──");
    const handlerBody = source.slice(handlerStart, handlerStart + 1200);
    const selectIdx = handlerBody.indexOf('.from("tasks").select("*")');
    expect(selectIdx).toBeGreaterThan(-1);
    const selectRegion = handlerBody.slice(selectIdx, selectIdx + 200);
    expect(selectRegion).toContain("company_id");
  });
});

// ── 2022-06b: assign_task UPDATE must include company_id ─────────────────────

describe("2022-06b assign_task — UPDATE must include company_id guard", () => {
  it("tasks/index.ts assign_task UPDATE must scope to company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("assign_task:");
    // Window must span the tool's schema (incl. the ONTG single-assignee
    // description added in v0.14.2) before reaching the handler's UPDATE.
    const handlerBody = source.slice(handlerStart, handlerStart + 2500);
    const updateIdx = handlerBody.indexOf(".update(");
    expect(updateIdx).toBeGreaterThan(-1);
    const updateRegion = handlerBody.slice(updateIdx, updateIdx + 200);
    expect(updateRegion).toContain("company_id");
  });
});

// ── BUG-04: transfer_between_accounts must reject same-account transfers ──────

describe("BUG-04 transfer_between_accounts — must reject same-account transfers", () => {
  it("financial/index.ts transfer handler must validate from_account_id !== to_account_id", () => {
    const source = readSource("financial/index.ts");
    const handlerStart = source.indexOf("transfer_between_accounts:");
    const handlerBody = source.slice(handlerStart, handlerStart + 2000);
    const hasSameAccountGuard =
      handlerBody.includes("from_account_id === to_account_id") ||
      handlerBody.includes("Cannot transfer to the same account");
    expect(hasSameAccountGuard).toBe(true);
  });
});

// ── NEW-04: add_account must reject negative initial_balance ──────────────────

describe("NEW-04 add_account — Zod schema must reject negative initial_balance", () => {
  it("financial/index.ts add_account schema must include nonnegative validation", () => {
    const source = readSource("financial/index.ts");
    const handlerStart = source.indexOf("add_account:");
    const schemaBody = source.slice(handlerStart, handlerStart + 600);
    expect(schemaBody).toContain("nonnegative");
  });
});

// ── NEW-05: complete_task must return already_done when already done ──────────

describe("NEW-05 complete_task — must return already_done:true when already done", () => {
  it("tasks/index.ts complete_task must include already_done response path", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("complete_task:");
    const handlerBody = source.slice(handlerStart, handlerStart + 2500);
    expect(handlerBody).toContain("already_done");
  });
});

// ── NEW-06: get_stuck_list overdue must include in_progress status ────────────

describe("NEW-06 get_stuck_list — overdue query must include in_progress status", () => {
  it("surfaces/index.ts overdue query must not use .eq('status','todo') exclusively", () => {
    const source = readSource("surfaces/index.ts");
    const handlerStart = source.indexOf("get_stuck_list:");
    const handlerBody = source.slice(handlerStart, handlerStart + 8000);
    const overdueComment = handlerBody.indexOf("// 3. Overdue");
    expect(overdueComment).toBeGreaterThan(-1);
    const overdueRegion = handlerBody.slice(overdueComment, overdueComment + 600);
    expect(overdueRegion).not.toContain('.eq("status", "todo")');
  });

  it("surfaces/index.ts overdue query must use .in('status', ...) with in_progress", () => {
    const source = readSource("surfaces/index.ts");
    const handlerStart = source.indexOf("get_stuck_list:");
    const handlerBody = source.slice(handlerStart, handlerStart + 8000);
    expect(handlerBody).toContain('.in("status", ["todo", "in_progress"])');
  });
});

// ── NEW-08: get_financial_summary must use getUTCFullYear ────────────────────

describe("NEW-08 get_financial_summary — must use getUTCFullYear not getFullYear", () => {
  it("financial/index.ts get_financial_summary must not use server-local getFullYear()", () => {
    const source = readSource("financial/index.ts");
    const handlerStart = source.indexOf("get_financial_summary:");
    const handlerBody = source.slice(handlerStart, handlerStart + 1500);
    expect(handlerBody).not.toContain("getFullYear()");
    expect(handlerBody).toContain("getUTCFullYear()");
  });
});

// ── 2022-07: memory_forget must check created_by for org memories ─────────────

describe("2022-07 memory_forget — must include created_by check for org memories", () => {
  it("memory/index.ts memory_forget delete filter must include created_by", () => {
    const source = readSource("memory/index.ts");
    const handlerStart = source.indexOf("memory_forget:");
    const handlerBody = source.slice(handlerStart, handlerStart + 2500);
    const deleteIdx = handlerBody.indexOf(".delete()");
    expect(deleteIdx).toBeGreaterThan(-1);
    const deleteRegion = handlerBody.slice(deleteIdx, deleteIdx + 300);
    expect(deleteRegion).toContain("created_by");
  });
});

// ── BUG-05: get_entity_card and friends must scope all reads to company_id ───
// Service role bypasses RLS, so every public read is a potential cross-company
// leak unless it carries .eq("company_id", ...). Migration 032 added
// company_id to task_links so the junction reads can scope directly. These
// tests guard the read sites against accidental regression.

describe("BUG-05a get_entity_card — top-level fetches must scope company_id", () => {
  const source = readSource("surfaces/index.ts");
  const handlerStart = source.indexOf("get_entity_card:");
  const handlerEnd = source.indexOf("get_session_start:", handlerStart);
  const handlerBody = source.slice(handlerStart, handlerEnd);

  it("customer top-level fetch must include company_id filter", () => {
    const block = handlerBody.match(
      /from\("customers"\)\s*\.select\("\*"\)[\s\S]{0,300}\.single\(\)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("contact top-level fetch must include company_id filter", () => {
    const block = handlerBody.match(
      /from\("contacts"\)\s*\.select[\s\S]{0,400}\.single\(\)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("transaction top-level fetch must include company_id filter", () => {
    const block = handlerBody.match(
      /from\("financial_transactions"\)\s*\.select\("\*[\s\S]{0,400}\.single\(\)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });
});

describe("BUG-05b get_entity_card — junction and child reads must scope company_id", () => {
  const source = readSource("surfaces/index.ts");
  const handlerStart = source.indexOf("get_entity_card:");
  const handlerEnd = source.indexOf("get_session_start:", handlerStart);
  const handlerBody = source.slice(handlerStart, handlerEnd);

  it("task_links open-tasks lookup must filter by company_id", () => {
    // Match the first task_links read (the open-tasks lookup at section 2).
    const block = handlerBody.match(
      /\.from\("task_links"\)\s*\.select\("task_id"\)[\s\S]{0,300}?(?=const taskIds)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("tasks fetch by id list must filter by company_id", () => {
    const block = handlerBody.match(
      /\.from\("tasks"\)\s*\.select[\s\S]{0,500}?\.in\("id", taskIds\)[\s\S]{0,300}?nullsFirst: false/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("interactions-by-customer fetch must filter by company_id", () => {
    const block = handlerBody.match(
      /\.from\("interactions"\)\s*\.select[\s\S]{0,300}?\.eq\("customer_id", entity_id\)[\s\S]{0,300}?\.limit\(5\)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("interactions-by-contact fetch must filter by company_id", () => {
    const block = handlerBody.match(
      /\.from\("interactions"\)\s*\.select[\s\S]{0,300}?\.eq\("contact_id", entity_id\)[\s\S]{0,300}?\.limit\(5\)/
    );
    expect(block).not.toBeNull();
    expect(block![0].includes(`eq("company_id", companyId)`) || block![0].includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });

  it("task_links mediated-transactions lookup must filter by company_id", () => {
    // Second task_links read (section 4b).
    const matches = [
      ...handlerBody.matchAll(
        /\.from\("task_links"\)[\s\S]{0,500}?(?=const)/g
      ),
    ];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const mediatedBlock = matches[1][0];
    expect(mediatedBlock.includes(`eq("company_id", companyId)`) || mediatedBlock.includes(`eq("company_id", ctx.companyId)`)).toBe(true);
  });
});

describe("BUG-05c task_links inserts must persist company_id", () => {
  it("create_task link insert must include company_id", () => {
    const source = readSource("tasks/index.ts");
    const block = source.match(
      /linkRows = params\.links\.map[\s\S]{0,400}?\}\)\)/
    );
    expect(block).not.toBeNull();
    expect(block![0]).toContain("company_id");
  });

  it("link_task upsert must include company_id", () => {
    const source = readSource("tasks/index.ts");
    const handlerStart = source.indexOf("link_task:");
    const handlerEnd = source.indexOf("unlink_task:", handlerStart);
    const handlerBody = source.slice(handlerStart, handlerEnd);
    expect(handlerBody).toMatch(/upsert\([^)]*company_id/);
  });

  it("playbook run task link insert must include company_id", () => {
    const source = readSource("playbooks/index.ts");
    // Match through the final "});" of the insert call. Earlier "})"
    // substrings exist inside (task as { id: string }).id, so anchor
    // on the terminator instead of a bare "})".
    const block = source.match(
      /\.from\("task_links"\)\.insert\(\{[\s\S]{0,400}?\}\);/
    );
    expect(block).not.toBeNull();
    expect(block![0]).toContain("company_id");
  });
});

// ── GROUNDWORK-01: composite-FK preconditions must remain in place ──────────
// Migration 033 (now consolidated into setup.sql) added UNIQUE(id, company_id)
// to every public table that is the target of a single-column FK from another
// company-scoped table. Stage 2 (separate PRs gated on multi-tenant launch)
// flips those FKs to composite form against this unique constraint. Removing
// any of these constraints would break Stage 2 silently, so we read setup.sql
// and assert every expected constraint is declared.

describe("GROUNDWORK-01 multi-tenant FK preconditions", () => {
  const sql = fs.readFileSync(path.join(supabaseDir, "setup.sql"), "utf8");

  const targets = [
    "customers",
    "contacts",
    "feed_catalog",
    "feeds",
    "financial_accounts",
    "financial_categories",
    "playbooks",
    "tasks",
    "triggers",
  ];

  for (const table of targets) {
    it(`${table} must declare UNIQUE(id, company_id) via ${table}_id_company_unique`, () => {
      // Both the constraint name and the column list need to be present.
      // Stricter than a bare substring check so a future edit that renames
      // the constraint OR changes the column order trips the test.
      const constraintName = `${table}_id_company_unique`;
      expect(sql).toContain(constraintName);
      const constraintIdx = sql.indexOf(constraintName);
      const region = sql.slice(constraintIdx, constraintIdx + 200);
      expect(region).toMatch(/unique\s*\(\s*id\s*,\s*company_id\s*\)/);
    });
  }

  it("setup.sql declares exactly 9 composite unique constraints", () => {
    // Replaces the count self-check the original migration carried in a
    // do-block. If another company-scoped FK target is added (or one is
    // dropped), update the targets list above together with this count.
    // 9th added 2026-06-24: triggers (Proactive Agents).
    const count = (sql.match(/_id_company_unique/g) ?? []).length;
    expect(count).toBe(9);
  });
});

// ── BUG-06: by-customer P&L (originally migration 034) ──────────────────────
// Three guards: the view shape stays correct (LEFT JOIN, same WHERE filters,
// no INNER on customers), the tool validates customer_id against company_id
// before querying, and the response remains additive (existing callers don't
// suddenly get a `by_customer` field they weren't asking for). The view now
// lives in setup.sql; the tests slice out its definition so assertions can't
// accidentally match the sibling financial_pl_summary view.

describe("BUG-06a financial_pl_by_customer_summary view shape", () => {
  const full = fs.readFileSync(path.join(supabaseDir, "setup.sql"), "utf8");
  const viewStart = full.indexOf(
    "create or replace view financial_pl_by_customer_summary"
  );
  const sql = full.slice(viewStart, full.indexOf(";", viewStart) + 1);

  it("setup.sql must define the view", () => {
    expect(viewStart).toBeGreaterThan(-1);
  });

  it("must LEFT JOIN customers (not INNER) so unattributed rows survive", () => {
    expect(sql).toMatch(/left join\s+customers/i);
    expect(sql).not.toMatch(/inner join\s+customers/i);
  });

  it("must apply the same WHERE filters as financial_pl_summary", () => {
    // exclude_from_reports=false, archived=false, deleted_at IS NULL.
    expect(sql).toMatch(/exclude_from_reports\s*=\s*false/);
    expect(sql).toMatch(/archived\s*=\s*false/);
    expect(sql).toMatch(/deleted_at\s+is\s+null/i);
  });

  it("must group by customer_id so the rollup is meaningful", () => {
    const groupMatch = sql.match(/group by[\s\S]{0,500}?;/i);
    expect(groupMatch).not.toBeNull();
    expect(groupMatch![0]).toContain("customer_id");
  });
});

describe("BUG-06b get_pl_report — customer_id must be validated against company_id", () => {
  const source = readSource("financial/index.ts");
  const handlerStart = source.indexOf("get_pl_report:");
  // get_pl_report sits before remove_transaction in the tool map; slice
  // through the next tool key to avoid catching unrelated handlers.
  const handlerEnd = source.indexOf("remove_transaction:", handlerStart);
  const handlerBody = source.slice(handlerStart, handlerEnd);

  it("customer_id validation block must filter by company_id and deleted_at", () => {
    // Find the customers fetch (only used for validation in this handler).
    const validationBlock = handlerBody.match(
      /from\("customers"\)[\s\S]{0,300}?\.single\(\)/
    );
    expect(validationBlock).not.toBeNull();
    expect(validationBlock![0]).toContain('eq("id", customer_id)');
    // After 2026-05-28 ToolContext refactor the literal is `ctx.companyId`;
    // legacy form `companyId` accepted for files still on the old pattern.
    expect(
      validationBlock![0].includes('eq("company_id", companyId)') ||
        validationBlock![0].includes('eq("company_id", ctx.companyId)')
    ).toBe(true);
    expect(validationBlock![0]).toContain('is("deleted_at", null)');
  });

  it("by-customer view query must scope by company_id", () => {
    const viewBlock = handlerBody.match(
      /from\("financial_pl_by_customer_summary"\)[\s\S]{0,500}?\.order/
    );
    expect(viewBlock).not.toBeNull();
    expect(
      viewBlock![0].includes('eq("company_id", companyId)') ||
        viewBlock![0].includes('eq("company_id", ctx.companyId)')
    ).toBe(true);
  });

  it("response must include by_customer only when grouping is requested (additive)", () => {
    // Spread-conditional pattern keeps the field out of the response when
    // group_by_customer is false, so existing callers see the same shape.
    expect(handlerBody).toMatch(/\.\.\.\(byCustomer\s*\?\s*\{\s*by_customer/);
  });
});
