// ============================================================
// Tests for task visibility and the personal assignment rule.
// Handlers run against a small in-memory stand-in for the
// Supabase client. No real DB required.
// ============================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import { taskTools } from "../tools/tasks/index.js";
import { dashboardTools } from "../tools/crm/dashboard.js";
import { restoreTools } from "../tools/restore.js";
import { customerTools } from "../tools/crm/customers.js";
import { surfaceTools } from "../tools/surfaces/index.js";
import { projectTools } from "../tools/projects/index.js";
import { financialManagementTools } from "../tools/financial/management.js";

vi.mock("../tools/memory/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/memory/embed.js")>();
  return { ...actual, embed: async () => [0.1, 0.2, 0.3] };
});

type Row = Record<string, any>;
type Filter = (row: Row) => boolean;

const NO_ROW = "JSON object requested, multiple (or no) rows returned";

/** Splits a PostgREST filter list on commas outside parentheses. */
function splitTop(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "(") depth++;
    else if (expr[i] === ")") depth--;
    else if (expr[i] === "," && depth === 0) {
      parts.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** Evaluates one term of an .or() filter, e.g. "scope.eq.org" or "and(...)". */
function termMatches(row: Row, term: string): boolean {
  if (term.startsWith("and(")) return splitTop(term.slice(4, -1)).every((t) => termMatches(row, t));
  if (term.startsWith("or(")) return splitTop(term.slice(3, -1)).some((t) => termMatches(row, t));
  const [column, op, ...rest] = term.split(".");
  const value = rest.join(".");
  if (op === "eq") return String(row[column]) === value;
  if (op === "neq") return String(row[column]) !== value;
  if (op === "is" && value === "null") return row[column] == null;
  throw new Error(`fake db: unsupported filter ${term}`);
}

/** In-memory stand-in for the Supabase query builder. */
class FakeQuery {
  private filters: Filter[] = [];
  private embedFilters: Filter[] = [];
  private embedTasks = false;
  private op: "select" | "insert" | "update" | "delete" | "upsert" | null = null;
  private payload: any = null;
  private head = false;
  private max = Infinity;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(private tables: Record<string, Row[]>, private table: string) {}

  private where(column: string, test: (v: any) => boolean) {
    // Filters on an embedded tasks row apply to that row. Filters on other
    // embedded tables (e.g. "customers.deleted_at") are ignored.
    if (column.startsWith("tasks.")) {
      const field = column.slice("tasks.".length);
      this.embedFilters.push((r) => test(r[field]));
    } else if (!column.includes(".")) {
      this.filters.push((r) => test(r[column]));
    }
    return this;
  }

  select(columns?: string, options?: { head?: boolean }) {
    if (!this.op) this.op = "select";
    if (columns?.includes("tasks(")) this.embedTasks = true;
    if (options?.head) this.head = true;
    return this;
  }
  insert(v: any) { this.op = "insert"; this.payload = v; return this; }
  upsert(v: any) { this.op = "upsert"; this.payload = v; return this; }
  update(v: any) { this.op = "update"; this.payload = v; return this; }
  delete() { this.op = "delete"; return this; }

  eq(c: string, v: any) { return this.where(c, (x) => x === v); }
  neq(c: string, v: any) { return this.where(c, (x) => x !== v); }
  is(c: string, v: any) { return this.where(c, (x) => (v === null ? x == null : x === v)); }
  in(c: string, vs: any[]) { return this.where(c, (x) => vs.includes(x)); }
  lt(c: string, v: any) { return this.where(c, (x) => x != null && x < v); }
  lte(c: string, v: any) { return this.where(c, (x) => x != null && x <= v); }
  gt(c: string, v: any) { return this.where(c, (x) => x != null && x > v); }
  gte(c: string, v: any) { return this.where(c, (x) => x != null && x >= v); }
  not(c: string, op: string, v: any) {
    if (op !== "is" || v !== null) throw new Error("fake db: unsupported not()");
    return this.where(c, (x) => x != null);
  }
  like(c: string, pattern: string) {
    const prefix = pattern.replace(/%$/, "");
    return this.where(c, (x) => typeof x === "string" && x.startsWith(prefix));
  }
  contains(c: string, vs: any[]) { return this.where(c, (x) => vs.every((v) => (x ?? []).includes(v))); }
  overlaps(c: string, vs: any[]) { return this.where(c, (x) => vs.some((v) => (x ?? []).includes(v))); }
  or(expr: string, options?: { referencedTable?: string }) {
    const filter: Filter = (r) => splitTop(expr).some((t) => termMatches(r, t));
    if (!options?.referencedTable) this.filters.push(filter);
    else if (options.referencedTable === "tasks") this.embedFilters.push(filter);
    return this;
  }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }

  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.run()).then(resolve, reject);
  }

  private run() {
    const rows = (this.tables[this.table] ??= []);
    const matches = () => rows.filter((r) => this.filters.every((f) => f(r)));
    let data: Row[];

    if (this.op === "insert" || this.op === "upsert") {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]).map(
        (item: Row) => ({ id: `${this.table}-${rows.length + 1}`, ...item })
      );
      rows.push(...items);
      data = items;
    } else if (this.op === "update") {
      data = matches();
      for (const r of data) Object.assign(r, this.payload);
    } else if (this.op === "delete") {
      data = matches();
      this.tables[this.table] = rows.filter((r) => !data.includes(r));
    } else {
      data = matches();
    }

    // Attach the linked task as `tasks`, or null when its filters drop it.
    if (this.embedTasks) {
      const taskRows = this.tables.tasks ?? [];
      data = data.map((r) => ({
        ...r,
        tasks: taskRows.find((t) => t.id === r.task_id && this.embedFilters.every((f) => f(t))) ?? null,
      }));
    }

    const count = data.length;
    data = data.slice(0, this.max).map((r) => ({ ...r }));

    if (this.mode !== "many") {
      if (data.length === 1) return { data: data[0], error: null };
      if (data.length === 0 && this.mode === "maybe") return { data: null, error: null };
      return { data: null, error: { message: NO_ROW } };
    }
    return { data: this.head ? null : data, count, error: null };
  }
}

function fakeDb(tables: Record<string, Row[]>) {
  return { from: (table: string) => new FakeQuery(tables, table) };
}

// ── Fixtures ─────────────────────────────────────────────────

const OVERDUE = "2000-01-01";
const MISSING = "00000000-0000-0000-0000-000000000000";

function task(id: string, fields: Row): Row {
  return {
    id,
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    scope: "org",
    created_by: "doug",
    assigned_to: null,
    blocked_reason: null,
    blocked_by_task_id: null,
    due_date: OVERDUE,
    completed_at: null,
    tags: [],
    company_id: "ott",
    archived_at: null,
    deleted_at: null,
    ...fields,
  };
}

let tables: Record<string, Row[]>;
let ctx: any;

beforeEach(() => {
  tables = {
    tasks: [
      task("org-task", { created_by: "vince" }),
      task("doug-personal", { scope: "personal" }),
      task("vince-personal", { scope: "personal", created_by: "vince", title: "Vince private" }),
      task("doug-org-for-vince", { assigned_to: "vince" }),
    ],
    task_links: [],
    task_notes: [],
    customers: [{ id: "cust-1", company_id: "ott", deleted_at: null }],
  };
  for (const t of tables.tasks) {
    tables.task_links.push({
      id: `link-${t.id}`,
      task_id: t.id,
      entity_type: "customer",
      entity_id: "cust-1",
      company_id: "ott",
    });
  }
  const db = fakeDb(tables);
  ctx = { db, admin: db, companyId: "ott", userId: "doug", identityMode: "env", isSoloMode: false };
});

const call = (name: string, params: Row) => (taskTools[name].handler as any)(ctx, params);

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to throw");
}

const row = (id: string) => tables.tasks.find((t) => t.id === id);
const ids = (list: Row[]) => list.map((t) => t.id);

// ── Hidden personal tasks ────────────────────────────────────

describe("another user's personal task looks like it does not exist", () => {
  const byIdCalls: Array<[string, (id: string) => Row]> = [
    ["get_task", (id) => ({ task_id: id })],
    ["update_task", (id) => ({ task_id: id, title: "changed" })],
    ["complete_task", (id) => ({ task_id: id, completion_note: "done" })],
    ["assign_task", (id) => ({ task_id: id, assigned_to: "@claude" })],
    ["add_task_note", (id) => ({ task_id: id, note: "hello" })],
    ["link_task", (id) => ({ task_id: id, entity_type: "contact", entity_id: "c-1" })],
    ["unlink_task", (id) => ({ task_id: id, entity_type: "customer", entity_id: "cust-1" })],
    ["remove_task", (id) => ({ task_id: id, mode: "delete" })],
  ];

  for (const [name, params] of byIdCalls) {
    it(`${name} returns the same error as for a missing task`, async () => {
      const missing = await errorOf(call(name, params(MISSING)));
      const hidden = await errorOf(call(name, params("vince-personal")));
      expect(hidden).toMatch(/Task not found/);
      expect(hidden).toBe(missing);
    });

    it(`${name} leaves the task, its notes and its links unchanged`, async () => {
      const before = JSON.stringify(tables);
      await errorOf(call(name, params("vince-personal")));
      expect(JSON.stringify(tables)).toBe(before);
    });
  }

  it("get_task still returns the caller's own personal task", async () => {
    const result = await call("get_task", { task_id: "doug-personal" });
    expect(result.task.id).toBe("doug-personal");
  });

  it("get_task does not show another user's personal task as the blocker", async () => {
    row("doug-personal")!.blocked_by_task_id = "vince-personal";
    row("vince-personal")!.blocked_by_task_id = "doug-personal";
    const result = await call("get_task", { task_id: "doug-personal" });
    expect(result.blocked_by).toBeNull();
    expect(ids(result.blocks)).not.toContain("vince-personal");
  });

  it("list_tasks returns org tasks and the caller's personal tasks only", async () => {
    const result = await call("list_tasks", {});
    expect(ids(result.tasks)).toEqual(["org-task", "doug-personal", "doug-org-for-vince"]);
  });

  it("list_tasks with scope personal returns only the caller's personal tasks", async () => {
    const result = await call("list_tasks", { scope: "personal" });
    expect(ids(result.tasks)).toEqual(["doug-personal"]);
  });

  it("list_entity_tasks excludes another user's personal task", async () => {
    const result = await call("list_entity_tasks", { entity_type: "customer", entity_id: "cust-1" });
    expect(ids(result.tasks)).not.toContain("vince-personal");
    expect(ids(result.tasks)).toContain("doug-personal");
  });

  it("get_task_summary excludes another user's personal task", async () => {
    const result = await call("get_task_summary", {});
    expect(ids(result.overdue)).not.toContain("vince-personal");
    expect(ids(result.overdue)).toContain("doug-personal");
  });
});

describe("get_dashboard excludes another user's personal tasks", () => {
  it("overdue tasks match list_tasks", async () => {
    const dash = await (dashboardTools.get_dashboard.handler as any)(ctx, { days: 7 });
    const list = await call("list_tasks", {});
    expect(ids(dash.overdue_tasks).sort()).toEqual(ids(list.tasks).sort());
  });

  it("the open tasks calendar leaves out another user's personal task", async () => {
    const dash = await (dashboardTools.get_dashboard.handler as any)(ctx, { days: 7 });
    const titles = dash.all_open_tasks_by_due_date.flatMap((d: { tasks: string[] }) => d.tasks);
    expect(titles).not.toContain("Vince private");
    expect(titles).toContain("doug-personal");
  });
});

describe("cards leave out another user's personal task", () => {
  it("get_customer open tasks", async () => {
    const result = await (customerTools.get_customer.handler as any)(ctx, { customer_id: "cust-1" });
    expect(ids(result.open_tasks)).not.toContain("vince-personal");
    expect(ids(result.open_tasks)).toContain("doug-personal");
  });

  it("get_entity_card open tasks", async () => {
    const result = await (surfaceTools.get_entity_card.handler as any)(ctx, {
      entity_type: "customer", entity_id: "cust-1",
    });
    expect(ids(result.open_tasks)).not.toContain("vince-personal");
    expect(ids(result.open_tasks)).toContain("doug-personal");
  });

  it("get_project tasks and counts", async () => {
    tables.projects = [{ id: "proj-1", company_id: "ott", deleted_at: null, tag_name: "launch", slug: "launch" }];
    row("doug-personal")!.tags = ["launch"];
    row("vince-personal")!.tags = ["launch"];
    const result = await (projectTools.get_project.handler as any)(ctx, { project_id: "proj-1" });
    expect(ids(result.tasks.todo)).toEqual(["doug-personal"]);
    expect(result.tasks.counts.todo).toBe(1);
  });
});

describe("surfaces leave out another user's personal task", () => {
  it("get_stuck_list excludes another user's personal task", async () => {
    const result = await (surfaceTools.get_stuck_list.handler as any)(ctx, {});
    const stuck = result.stuck_list.map((i: Row) => i.task);
    expect(ids(stuck)).not.toContain("vince-personal");
    expect(ids(stuck)).toContain("doug-personal");
  });

  it("get_weekly_retro excludes another user's personal task and its notes", async () => {
    const now = new Date().toISOString();
    for (const id of ["doug-personal", "vince-personal"]) {
      Object.assign(row(id)!, { status: "done", completed_at: now });
    }
    tables.task_notes.push(
      { id: "n-1", task_id: "doug-personal", note: "Doug note", created_at: now },
      { id: "n-2", task_id: "vince-personal", note: "Vince secret note", created_at: now }
    );
    const result = JSON.stringify(await (surfaceTools.get_weekly_retro.handler as any)(ctx, {}));
    expect(result).not.toContain("Vince private");
    expect(result).not.toContain("Vince secret note");
    expect(result).toContain("Doug note");
  });

  it("list_projects counts exclude another user's personal task", async () => {
    tables.projects = [
      { id: "proj-1", company_id: "ott", deleted_at: null, status: "active", name: "Launch", tag_name: "launch", slug: "launch" },
    ];
    tables.tag_registry = [];
    row("doug-personal")!.tags = ["launch"];
    row("vince-personal")!.tags = ["launch"];
    const result = await (projectTools.list_projects.handler as any)(ctx, {});
    expect(result.projects[0].task_counts.todo).toBe(1);
  });
});

// ── Personal means mine ──────────────────────────────────────

describe("create_task: a personal task cannot go to another person", () => {
  it("returns a conflict for another person and creates nothing", async () => {
    const result = await call("create_task", { title: "x", scope: "personal", assigned_to: "vince" });
    expect(result.conflict.type).toBe("validation_mismatch");
    expect(result.conflict.options.map((o: Row) => o.key)).toEqual(["make_org", "cancel"]);
    expect(tables.tasks).toHaveLength(4);
  });

  for (const assigned_to of ["doug", "Doug", "@claude", "@gpt", undefined]) {
    it(`allows ${assigned_to ?? "no assignee"}`, async () => {
      const result = await call("create_task", { title: "x", scope: "personal", assigned_to });
      expect(result.conflict).toBeUndefined();
      expect(result.task.scope).toBe("personal");
      expect(result.task.assigned_to).toBe(assigned_to ?? null);
    });
  }

  it("allows another person on an org task", async () => {
    const result = await call("create_task", { title: "x", assigned_to: "vince" });
    expect(result.conflict).toBeUndefined();
    expect(result.task.scope).toBe("org");
  });

  it("make_org creates it as an org task", async () => {
    const result = await call("create_task", {
      title: "x", scope: "personal", assigned_to: "vince", resolution: "make_org",
    });
    expect(result.task.scope).toBe("org");
    expect(result.task.assigned_to).toBe("vince");
  });

  it("cancel creates nothing", async () => {
    const result = await call("create_task", {
      title: "x", scope: "personal", assigned_to: "vince", resolution: "cancel",
    });
    expect(result.success).toBe(false);
    expect(tables.tasks).toHaveLength(4);
  });
});

describe("assign_task: a personal task cannot go to another person", () => {
  it("returns a conflict for another person and changes nothing", async () => {
    const result = await call("assign_task", { task_id: "doug-personal", assigned_to: "vince" });
    expect(result.conflict.type).toBe("validation_mismatch");
    expect(result.conflict.options.map((o: Row) => o.key)).toEqual(["make_org", "cancel"]);
    expect(row("doug-personal")!.assigned_to).toBeNull();
  });

  for (const assigned_to of ["doug", "DOUG", "@claude", ""]) {
    it(`allows ${assigned_to || "unassigning"}`, async () => {
      const result = await call("assign_task", { task_id: "doug-personal", assigned_to });
      expect(result.conflict).toBeUndefined();
      expect(row("doug-personal")!.assigned_to).toBe(assigned_to || null);
      expect(row("doug-personal")!.scope).toBe("personal");
    });
  }

  it("allows another person on an org task", async () => {
    const result = await call("assign_task", { task_id: "org-task", assigned_to: "vince" });
    expect(result.conflict).toBeUndefined();
    expect(row("org-task")!.assigned_to).toBe("vince");
  });

  it("make_org assigns it and makes it an org task", async () => {
    await call("assign_task", { task_id: "doug-personal", assigned_to: "vince", resolution: "make_org" });
    expect(row("doug-personal")!.assigned_to).toBe("vince");
    expect(row("doug-personal")!.scope).toBe("org");
  });

  it("cancel changes nothing", async () => {
    const result = await call("assign_task", { task_id: "doug-personal", assigned_to: "vince", resolution: "cancel" });
    expect(result.success).toBe(false);
    expect(row("doug-personal")!.assigned_to).toBeNull();
  });
});

describe("update_task: a personal task cannot go to another person", () => {
  it("returns a conflict when assigning a personal task to another person", async () => {
    const result = await call("update_task", { task_id: "doug-personal", assigned_to: "vince" });
    expect(result.conflict.type).toBe("validation_mismatch");
    expect(row("doug-personal")!.assigned_to).toBeNull();
  });

  it("returns a conflict when switching a task to personal while it is assigned to another person", async () => {
    const result = await call("update_task", { task_id: "doug-org-for-vince", scope: "personal" });
    expect(result.conflict.type).toBe("validation_mismatch");
    expect(row("doug-org-for-vince")!.scope).toBe("org");
  });

  it("returns a conflict when switching to personal and assigning another person together", async () => {
    tables.tasks.push(task("doug-org", {}));
    const result = await call("update_task", { task_id: "doug-org", scope: "personal", assigned_to: "vince" });
    expect(result.conflict.type).toBe("validation_mismatch");
    expect(row("doug-org")!.scope).toBe("org");
  });

  for (const assigned_to of ["doug", "Doug", "@claude", ""]) {
    it(`allows assigning a personal task to ${assigned_to || "nobody"}`, async () => {
      const result = await call("update_task", { task_id: "doug-personal", assigned_to });
      expect(result.conflict).toBeUndefined();
      expect(row("doug-personal")!.assigned_to).toBe(assigned_to || null);
    });
  }

  it("allows switching to personal while unassigning in the same call", async () => {
    const result = await call("update_task", { task_id: "doug-org-for-vince", scope: "personal", assigned_to: "" });
    expect(result.conflict).toBeUndefined();
    expect(row("doug-org-for-vince")!.scope).toBe("personal");
    expect(row("doug-org-for-vince")!.assigned_to).toBeNull();
  });

  it("does not fire for an edit that changes neither scope nor assignee", async () => {
    row("doug-personal")!.assigned_to = "vince";
    const result = await call("update_task", { task_id: "doug-personal", title: "renamed" });
    expect(result.conflict).toBeUndefined();
    expect(row("doug-personal")!.title).toBe("renamed");
  });

  it("rejects making another person's org task personal", async () => {
    const message = await errorOf(call("update_task", { task_id: "org-task", scope: "personal" }));
    expect(message).toMatch(/Only the task's creator can make it a personal task/);
    expect(row("org-task")!.scope).toBe("org");
  });

  it("lets the creator make their own org task personal", async () => {
    tables.tasks.push(task("doug-org", {}));
    const result = await call("update_task", { task_id: "doug-org", scope: "personal" });
    expect(result.success).toBe(true);
    expect(row("doug-org")!.scope).toBe("personal");
  });

  it("make_org applies the update as an org task", async () => {
    await call("update_task", { task_id: "doug-personal", assigned_to: "vince", resolution: "make_org" });
    expect(row("doug-personal")!.assigned_to).toBe("vince");
    expect(row("doug-personal")!.scope).toBe("org");
  });

  it("cancel changes nothing", async () => {
    const result = await call("update_task", { task_id: "doug-personal", assigned_to: "vince", resolution: "cancel" });
    expect(result.success).toBe(false);
    expect(row("doug-personal")!.assigned_to).toBeNull();
  });
});

// ── Blockers ─────────────────────────────────────────────────

describe("blocked_by_task_id must be a task the caller can see", () => {
  it("create_task rejects another user's personal task as the blocker like a missing task", async () => {
    const missing = await errorOf(call("create_task", { title: "x", status: "blocked", blocked_by_task_id: MISSING }));
    const hidden = await errorOf(call("create_task", { title: "x", status: "blocked", blocked_by_task_id: "vince-personal" }));
    expect(hidden).toMatch(/Task not found/);
    expect(hidden).toBe(missing);
    expect(tables.tasks).toHaveLength(4);
  });

  it("create_task accepts a blocker the caller can see", async () => {
    const result = await call("create_task", { title: "x", status: "blocked", blocked_by_task_id: "doug-personal" });
    expect(result.task.blocked_by_task_id).toBe("doug-personal");
  });

  it("update_task rejects another user's personal task as the blocker like a missing task", async () => {
    const missing = await errorOf(call("update_task", { task_id: "doug-personal", blocked_by_task_id: MISSING }));
    const hidden = await errorOf(call("update_task", { task_id: "doug-personal", blocked_by_task_id: "vince-personal" }));
    expect(hidden).toMatch(/Task not found/);
    expect(hidden).toBe(missing);
    expect(row("doug-personal")!.blocked_by_task_id).toBeNull();
  });

  it("update_task accepts a visible blocker and clears with an empty string", async () => {
    await call("update_task", { task_id: "doug-personal", blocked_by_task_id: "org-task" });
    expect(row("doug-personal")!.blocked_by_task_id).toBe("org-task");
    await call("update_task", { task_id: "doug-personal", blocked_by_task_id: "" });
    expect(row("doug-personal")!.blocked_by_task_id).toBeNull();
  });
});

// ── Completion memories ──────────────────────────────────────

describe("complete_task store_as_memory follows the task's scope", () => {
  it("stores a personal memory for a personal task", async () => {
    const result = await call("complete_task", {
      task_id: "doug-personal", completion_note: "done", store_as_memory: true,
    });
    expect(result.memory_stored).toBe(true);
    expect(tables.memories).toHaveLength(1);
    expect(tables.memories[0]).toMatchObject({ scope: "personal", user_id: "doug", created_by: "doug" });
  });

  it("stores an org memory for an org task", async () => {
    const result = await call("complete_task", {
      task_id: "org-task", completion_note: "done", store_as_memory: true,
    });
    expect(result.memory_stored).toBe(true);
    expect(tables.memories).toHaveLength(1);
    expect(tables.memories[0]).toMatchObject({ scope: "org", user_id: "org" });
  });
});

// ── Trash ────────────────────────────────────────────────────

describe("the trash hides another user's personal tasks", () => {
  const DELETED = new Date(Date.now() - 86_400_000).toISOString();

  beforeEach(() => {
    tables.tasks.push(
      task("trash-org", { deleted_at: DELETED, title: "Org trash" }),
      task("trash-doug", { scope: "personal", deleted_at: DELETED, title: "Doug trash" }),
      task("trash-vince", { scope: "personal", created_by: "vince", deleted_at: DELETED, title: "Vince trash" })
    );
    tables.company_members = [{ id: "m-1", user_id: "doug", company_id: "ott", is_owner: false }];
  });

  const restoreCall = (name: string, params: Row) => (restoreTools[name].handler as any)(ctx, params);

  it("list_deleted leaves out another user's personal task", async () => {
    const result = await restoreCall("list_deleted", { entity_type: "task" });
    const labels = result.items.map((i: Row) => i.label);
    expect(labels).toContain("Org trash");
    expect(labels).toContain("Doug trash");
    expect(labels).not.toContain("Vince trash");
  });

  it("purge_items by filter does not count or name another user's personal task", async () => {
    const result = await restoreCall("purge_items", { entity_type: "task" });
    expect(result.conflict.context.count).toBe(2);
    expect(JSON.stringify(result)).not.toContain("Vince trash");
  });

  it("restore_items by filter leaves another user's personal task in the trash", async () => {
    const result = await restoreCall("restore_items", { entity_type: "task" });
    expect(result.restored_count).toBe(2);
    expect(row("trash-vince")!.deleted_at).toBe(DELETED);
    expect(JSON.stringify(result)).not.toContain("Vince trash");
  });

  it("restore_items with an explicit id does not show another user's personal task title", async () => {
    const result = await restoreCall("restore_items", { items: [{ entity_type: "task", entity_id: "trash-vince" }] });
    expect(result.restored_count).toBe(0);
    expect(row("trash-vince")!.deleted_at).toBe(DELETED);
    expect(JSON.stringify(result)).not.toContain("Vince trash");
  });

  it("purge_items with an explicit id does not show another user's personal task title", async () => {
    const result = await restoreCall("purge_items", { items: [{ entity_type: "task", entity_id: "trash-vince" }] });
    expect(JSON.stringify(result)).not.toContain("Vince trash");
  });

  for (const is_owner of [false, true]) {
    describe(`by id, for ${is_owner ? "an owner" : "a non-owner"}`, () => {
      beforeEach(() => {
        tables.company_members[0].is_owner = is_owner;
      });

      const byId = (id: string) => ({ entity_type: "task", entity_id: id });
      const audit = () => tables.audit_log ?? [];

      for (const name of ["restore_item", "purge_item"]) {
        it(`${name} treats another user's personal task as not found`, async () => {
          const missing = await errorOf(restoreCall(name, byId(MISSING)));
          const hidden = await errorOf(restoreCall(name, { ...byId("trash-vince"), resolution: "confirm" }));
          expect(hidden).toBe(missing);
          expect(hidden).not.toContain("Vince trash");
          expect(row("trash-vince")!.deleted_at).toBe(DELETED);
          expect(audit()).toHaveLength(0);
        });
      }

      for (const name of ["restore_items", "purge_items"]) {
        it(`${name} with an explicit id treats another user's personal task as not found`, async () => {
          const missing = await restoreCall(name, { items: [byId(MISSING)], resolution: "confirm" });
          const hidden = await restoreCall(name, { items: [byId("trash-vince")], resolution: "confirm" });
          expect(hidden).toEqual(missing);
          expect(row("trash-vince")!.deleted_at).toBe(DELETED);
          expect(audit()).toHaveLength(0);
        });
      }

      it("restore_item and purge_item record the task's scope and creator", async () => {
        await restoreCall("restore_item", byId("trash-doug"));
        row("trash-org")!.created_by = "vince";
        await restoreCall("purge_item", { ...byId("trash-org"), resolution: "confirm" });
        expect(audit().map((e: Row) => e.before_state)).toEqual([
          expect.objectContaining({ scope: "personal", created_by: "doug" }),
          expect.objectContaining({ scope: "org", created_by: "vince" }),
        ]);
      });

      it("restore_item still restores the caller's own personal task", async () => {
        const result = await restoreCall("restore_item", byId("trash-doug"));
        expect(result.success).toBe(true);
        expect(row("trash-doug")!.deleted_at).toBeNull();
      });
    });
  }
});

// ── Audit log ────────────────────────────────────────────────

describe("get_audit_log hides entries about another user's personal task", () => {
  const entry = (id: string, actor_id: string, action: string, entity_id: string, before_state: Row | null) => ({
    id,
    company_id: "ott",
    actor_id,
    action,
    entity_type: action.endsWith("_task") ? "task" : "company_member",
    entity_id,
    before_state,
    after_state: null,
    metadata: null,
    created_at: "2026-11-01T00:00:00Z",
  });

  beforeEach(() => {
    tables.company_members = [{ id: "m-1", user_id: "doug", company_id: "ott", is_owner: true }];
    tables.audit_log = [
      entry("vince-row", "vince", "delete_task", "vince-personal", { scope: "personal" }),
      entry("vince-purged", "vince", "purge_task", "gone-vince", { label: "x", scope: "personal", created_by: "vince" }),
      entry("doug-row", "doug", "delete_task", "doug-personal", { scope: "personal" }),
      entry("doug-purged", "doug", "purge_task", "gone-doug", { label: "y", scope: "personal", created_by: "doug" }),
      entry("org-row", "vince", "delete_task", "org-task", { scope: "org" }),
      entry("org-purged", "vince", "purge_task", "gone-org", { label: "z", scope: "org", created_by: "vince" }),
      entry("access", "vince", "set_financial_access", "vince", null),
    ];
  });

  const auditIds = async () => {
    const result = await (financialManagementTools.get_audit_log.handler as any)(ctx, { scope: "all" });
    return result.entries.map((e: Row) => e.id).sort();
  };

  it("leaves out another user's personal task, with the row present or purged", async () => {
    const shown = await auditIds();
    expect(shown).not.toContain("vince-row");
    expect(shown).not.toContain("vince-purged");
  });

  it("keeps the caller's own personal task, org tasks and other entries", async () => {
    expect(await auditIds()).toEqual(["access", "doug-purged", "doug-row", "org-purged", "org-row"]);
  });

  it("shows the creator their own personal task entries", async () => {
    ctx.userId = "vince";
    tables.company_members.push({ id: "m-2", user_id: "vince", company_id: "ott", is_owner: true });
    const shown = await auditIds();
    expect(shown).toContain("vince-row");
    expect(shown).toContain("vince-purged");
    expect(shown).not.toContain("doug-row");
    expect(shown).not.toContain("doug-purged");
  });
});

describe("remove_task records the task's creator in the audit entry", () => {
  it("delete", async () => {
    await call("remove_task", { task_id: "doug-personal", mode: "delete" });
    expect(tables.audit_log[0].before_state).toMatchObject({ scope: "personal", created_by: "doug" });
  });
});
