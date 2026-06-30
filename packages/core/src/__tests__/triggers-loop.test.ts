// ============================================================
// Founders OS — Triggers loop (integration, in-memory DB)
// ============================================================
// Exercises the REAL evaluate_triggers and report_trigger_observation
// handlers against an in-memory stand-in that models the query chains
// the evaluators and the fire-claim use. Asserts the behavior that makes
// a watcher useful: fire once when a situation becomes true, do NOT
// re-fire while it is unchanged, re-fire when it worsens, and record the
// all-clear so a later re-match fires again. Connector conditions return
// a check and fire only when the agent reports a matching observation.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { triggerTools } from "../tools/triggers/index.js";
import { evaluateDataTriggers } from "../tools/triggers/evaluate.js";
import type { ToolContext } from "../types/context.js";

type Row = Record<string, unknown>;

// ── In-memory Supabase stand-in (operators the triggers code uses) ──
class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row | null = null;
  private inserted: Row[] = [];
  private orderCol: string | null = null;

  constructor(private store: Map<string, Row[]>, private table: string) {}
  private rows(): Row[] {
    if (!this.store.has(this.table)) this.store.set(this.table, []);
    return this.store.get(this.table)!;
  }
  private matched(): Row[] {
    return this.rows().filter((r) => this.filters.every((f) => f(r)));
  }

  select(_c?: string): this { if (this.op !== "update" && this.op !== "insert") this.op = "select"; return this; }
  eq(c: string, v: unknown): this { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown): this { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: unknown[]): this { this.filters.push((r) => vs.includes(r[c])); return this; }
  lt(c: string, v: unknown): this { this.filters.push((r) => r[c] != null && (r[c] as never) < (v as never)); return this; }
  gte(c: string, v: unknown): this { this.filters.push((r) => r[c] != null && (r[c] as never) >= (v as never)); return this; }
  is(c: string, v: null): this { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: "is", v: null): this { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  order(c: string): this { this.orderCol = c; return this; }

  or(filterStr: string): this {
    const clauses = filterStr.split(",").map((clause) => {
      const dot = clause.split(".");
      const col = dot[0];
      const opName = dot[1];
      const val = dot.slice(2).join(".");
      return (r: Row): boolean => {
        if (opName === "is" && val === "null") return (r[col] ?? null) === null;
        if (opName === "neq") return r[col] !== val;
        if (opName === "eq") return r[col] === val;
        return false;
      };
    });
    this.filters.push((r) => clauses.some((c) => c(r)));
    return this;
  }

  update(p: Row): this { this.op = "update"; this.patch = p; return this; }
  insert(p: Row | Row[]): this {
    this.op = "insert";
    const arr = Array.isArray(p) ? p : [p];
    for (const row of arr) {
      const withId = { id: row.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...row };
      this.rows().push(withId);
      this.inserted.push(withId);
    }
    return this;
  }

  // Terminal upsert (awaited directly): replace a row matching the
  // onConflict columns, else insert. Models ctx.db.from(t).upsert(row, opts).
  async upsert(p: Row, opts?: { onConflict?: string }): Promise<{ data: Row | null; error: null }> {
    const cols = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const rows = this.rows();
    if (cols.length) {
      const existing = rows.find((r) => cols.every((c) => r[c] === p[c]));
      if (existing) { Object.assign(existing, p); return { data: { ...existing }, error: null }; }
    }
    const withId = { id: p.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...p };
    rows.push(withId);
    return { data: { ...withId }, error: null };
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "insert") return { data: this.inserted[0] ? { ...this.inserted[0] } : null, error: null };
    if (this.op === "update") {
      const target = this.matched()[0];
      if (!target) return { data: null, error: null };
      Object.assign(target, this.patch);
      return { data: { ...target }, error: null };
    }
    const found = this.matched()[0];
    return { data: found ? { ...found } : null, error: null };
  }

  // Awaiting the builder directly resolves a select (used by evaluators
  // and the trigger load in evaluate_triggers).
  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    let rows = this.matched().map((r) => ({ ...r }));
    if (this.orderCol) rows = rows.sort((a, b) => String(a[this.orderCol!]).localeCompare(String(b[this.orderCol!])));
    return resolve({ data: rows, error: null });
  }
}

class FakeDb {
  constructor(public store: Map<string, Row[]>) {}
  from(t: string): FakeQuery { return new FakeQuery(this.store, t); }

  // Models the claim_trigger_fire RPC (migration 041): atomic conditional
  // claim with last_state IS DISTINCT FROM p_fp.
  async rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    if (name === "claim_trigger_fire") {
      const rows = this.store.get("triggers") ?? [];
      const t = rows.find(
        (r) => r.company_id === params.p_company_id && r.id === params.p_trigger_id
      );
      if (!t) return { data: false, error: null };
      if (t.last_state === params.p_fp) return { data: false, error: null }; // not distinct
      t.last_state = params.p_fp;
      if (params.p_matched) t.last_fired_at = new Date().toISOString();
      return { data: true, error: null };
    }
    return { data: null, error: null };
  }
}

function makeCtx(store: Map<string, Row[]>): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"],
    admin: db as unknown as ToolContext["admin"],
    companyId: "default",
    userId: "agent",
    identityMode: "env",
    isSoloMode: true,
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

const evaluate = (ctx: ToolContext, params: unknown = {}) =>
  (triggerTools.evaluate_triggers.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const report = (ctx: ToolContext, params: unknown) =>
  (triggerTools.report_trigger_observation.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const listFires = (ctx: ToolContext, params: unknown = {}) =>
  (triggerTools.list_trigger_fires.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const resolveFire = (ctx: ToolContext, params: unknown) =>
  (triggerTools.resolve_trigger_fire.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe("data loop — stuck_task fires once, dedups, re-fires on worsening, records all-clear", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new Map<string, Row[]>();
    store.set("triggers", [
      {
        id: "trg-1", company_id: "default", name: "Stuck tasks",
        condition_source: "data", condition_type: "stuck_task", connector: null,
        params: { days: 7 }, action_type: "notify", playbook_id: null, action_params: {},
        last_state: null, last_fired_at: null, created_by: "agent", enabled: true, deleted_at: null,
      },
    ]);
    store.set("tasks", [
      { id: "task-1", company_id: "default", status: "in_progress", updated_at: daysAgo(10), deleted_at: null },
    ]);
  });

  it("fires once, then dedups while unchanged", async () => {
    const first = await evaluate(ctx = makeCtx(store));
    expect(first.fired_count).toBe(1);
    expect(first.fired[0].condition_type).toBe("stuck_task");

    const second = await evaluate(ctx);
    expect(second.fired_count).toBe(0);
  });

  it("re-fires when the situation worsens (bucket changes)", async () => {
    ctx = makeCtx(store);
    expect((await evaluate(ctx)).fired_count).toBe(1);
    // Task slips from the b2 (7-13d) bucket to b4 (30-59d).
    store.get("tasks")![0].updated_at = daysAgo(40);
    expect((await evaluate(ctx)).fired_count).toBe(1);
    // No further change -> deduped.
    expect((await evaluate(ctx)).fired_count).toBe(0);
  });

  it("records the all-clear when it stops matching, then re-fires when it matches again", async () => {
    ctx = makeCtx(store);
    expect((await evaluate(ctx)).fired_count).toBe(1);
    // Task completed -> no longer in_progress -> not matched.
    store.get("tasks")![0].status = "done";
    expect((await evaluate(ctx)).fired_count).toBe(0);
    // It comes back -> re-fires.
    store.get("tasks")![0].status = "in_progress";
    store.get("tasks")![0].updated_at = daysAgo(9);
    expect((await evaluate(ctx)).fired_count).toBe(1);
  });

  it("dry_evaluate reports what would fire but writes no state", async () => {
    ctx = makeCtx(store);
    const dry = await evaluate(ctx, { dry_evaluate: true });
    expect(dry.fired_count).toBe(1);
    // last_state was not written, so a real evaluate still fires.
    expect((await evaluate(ctx)).fired_count).toBe(1);
  });
});

describe("detect inbox — evaluateDataTriggers writeInbox upserts trigger_fires", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new Map<string, Row[]>();
    store.set("triggers", [
      {
        id: "trg-od", company_id: "default", name: "Overdue tasks",
        condition_source: "data", condition_type: "overdue_task", connector: null,
        params: {}, action_type: "notify", playbook_id: null, action_params: { channel: "#ops" },
        last_state: null, last_fired_at: null, created_by: "agent", enabled: true, deleted_at: null,
      },
    ]);
    store.set("tasks", [
      { id: "task-od", company_id: "default", status: "todo", due_date: "2020-01-01", deleted_at: null },
    ]);
    ctx = makeCtx(store);
  });

  it("writes one pending inbox row when a data trigger fires", async () => {
    const res = await evaluateDataTriggers(ctx, { writeInbox: true });
    expect(res.fired.length).toBe(1);
    const inbox = store.get("trigger_fires") ?? [];
    expect(inbox.length).toBe(1);
    expect(inbox[0].status).toBe("pending");
    expect(inbox[0].trigger_id).toBe("trg-od");
    expect(inbox[0].condition_type).toBe("overdue_task");
    expect(typeof inbox[0].fingerprint).toBe("string");
  });

  it("does not stack duplicates: an unchanged re-run leaves one row", async () => {
    await evaluateDataTriggers(ctx, { writeInbox: true });
    await evaluateDataTriggers(ctx, { writeInbox: true }); // deduped -> no fire -> no upsert
    expect((store.get("trigger_fires") ?? []).length).toBe(1);
  });

  it("does not write the inbox when writeInbox is false (the in-session tool path)", async () => {
    await evaluateDataTriggers(ctx, { writeInbox: false });
    expect(store.get("trigger_fires") ?? []).toEqual([]);
  });

  it("list_trigger_fires surfaces the pending fire", async () => {
    await evaluateDataTriggers(ctx, { writeInbox: true });
    const listed = await listFires(ctx, {});
    expect(listed.count).toBe(1);
    expect(String(listed.fires[0].brief)).toContain("overdue");
  });

  // The evaluate_triggers TOOL exposes write_inbox so a session can force a
  // check that also stages fires (e.g. for testing the run pipeline).
  it("evaluate_triggers tool leaves the inbox empty by default", async () => {
    const res = await evaluate(ctx);
    expect(res.fired_count).toBe(1);
    expect(store.get("trigger_fires") ?? []).toEqual([]);
  });

  it("evaluate_triggers tool with write_inbox:true stages the fire", async () => {
    const res = await evaluate(ctx, { write_inbox: true });
    expect(res.fired_count).toBe(1);
    const inbox = store.get("trigger_fires") ?? [];
    expect(inbox.length).toBe(1);
    expect(inbox[0].status).toBe("pending");
  });

  it("evaluate_triggers tool ignores write_inbox when dry_evaluate is true", async () => {
    const res = await evaluate(ctx, { write_inbox: true, dry_evaluate: true });
    expect(res.fired_count).toBe(1); // dry still reports what would fire
    expect(store.get("trigger_fires") ?? []).toEqual([]); // but writes nothing
  });
});

describe("Q1/Q2 — a misconfigured trigger is isolated, not fatal, and surfaced", () => {
  it("a data trigger with no evaluator is reported in errors and does not starve a healthy trigger", async () => {
    const store = new Map<string, Row[]>();
    store.set("triggers", [
      // Misconfigured: a connector condition_type stored as a data source -> no evaluator.
      { id: "bad", company_id: "default", name: "Broken watch", condition_source: "data", condition_type: "overdue_invoice", connector: null, params: {}, action_type: "notify", playbook_id: null, action_params: {}, last_state: null, created_by: "agent", enabled: true, deleted_at: null },
      // Healthy stuck_task that should still fire.
      { id: "good", company_id: "default", name: "Stuck tasks", condition_source: "data", condition_type: "stuck_task", connector: null, params: { days: 7 }, action_type: "notify", playbook_id: null, action_params: {}, last_state: null, created_by: "agent", enabled: true, deleted_at: null },
    ]);
    store.set("tasks", [{ id: "task-1", company_id: "default", status: "in_progress", updated_at: daysAgo(10), deleted_at: null }]);
    const ctx = makeCtx(store);

    const r = await evaluate(ctx);
    expect(r.fired_count).toBe(1); // the healthy trigger still fired
    expect(r.error_count).toBe(1);
    expect(r.errors[0].name).toBe("Broken watch");
  });
});

describe("connector loop — overdue_invoice returns a check, reports fire + dedup", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new Map<string, Row[]>();
    store.set("triggers", [
      {
        id: "trg-inv", company_id: "default", name: "Overdue invoices",
        condition_source: "connector", condition_type: "overdue_invoice", connector: "stripe",
        params: { days: 3 }, action_type: "notify", playbook_id: null, action_params: {},
        last_state: null, last_fired_at: null, created_by: "agent", enabled: true, deleted_at: null,
      },
    ]);
    ctx = makeCtx(store);
  });

  it("evaluate returns a connector_check and does not fire", async () => {
    const r = await evaluate(ctx);
    expect(r.fired_count).toBe(0);
    expect(r.connector_check_count).toBe(1);
    expect(r.connector_checks[0].connector).toBe("stripe");
    expect(r.connector_checks[0].trigger_id).toBe("trg-inv");
  });

  it("report fires once, dedups the same observation, and re-fires after an all-clear", async () => {
    const first = await report(ctx, { trigger_id: "trg-inv", rows: [{ id: "inv_1" }], state: "b1" });
    expect(first.fired).toBe(true);

    const same = await report(ctx, { trigger_id: "trg-inv", rows: [{ id: "inv_1" }], state: "b1" });
    expect(same.fired).toBe(false);

    // Worsens (same invoice, deeper overdue bucket) -> re-fires.
    const worse = await report(ctx, { trigger_id: "trg-inv", rows: [{ id: "inv_1" }], state: "b3" });
    expect(worse.fired).toBe(true);

    // Paid off -> all-clear (no fire).
    const clear = await report(ctx, { trigger_id: "trg-inv", rows: [], state: "" });
    expect(clear.fired).toBe(false);

    // Comes back -> fires again.
    const back = await report(ctx, { trigger_id: "trg-inv", rows: [{ id: "inv_1" }], state: "b1" });
    expect(back.fired).toBe(true);
  });

  it("refuses report_trigger_observation for a data condition", async () => {
    store.get("triggers")!.push({
      id: "trg-data", company_id: "default", name: "x", condition_source: "data",
      condition_type: "stuck_task", connector: null, params: {}, action_type: "notify",
      playbook_id: null, action_params: {}, last_state: null, created_by: "agent", enabled: true, deleted_at: null,
    });
    await expect(report(ctx, { trigger_id: "trg-data", rows: [{ id: "a" }] })).rejects.toThrow(/data condition/i);
  });
});

describe("scope filter — a personal task watch only sees the owner's tasks (M3)", () => {
  function setup(scope: "org" | "personal", ownerId: string | null): Map<string, Row[]> {
    const store = new Map<string, Row[]>();
    store.set("triggers", [
      {
        id: "trg-od", company_id: "default", name: "Overdue", scope, owner_id: ownerId,
        condition_source: "data", condition_type: "overdue_task", connector: null,
        params: {}, action_type: "notify", playbook_id: null, action_params: {},
        last_state: null, last_fired_at: null, created_by: "agent", enabled: true, deleted_at: null,
      },
    ]);
    store.set("tasks", [
      { id: "t-created-mine", company_id: "default", status: "todo", due_date: "2020-01-01", created_by: "agent", assigned_to: null, deleted_at: null },
      { id: "t-assigned-mine", company_id: "default", status: "todo", due_date: "2020-01-01", created_by: "doug", assigned_to: "agent", deleted_at: null },
      { id: "t-dougs", company_id: "default", status: "todo", due_date: "2020-01-01", created_by: "doug", assigned_to: "doug", deleted_at: null },
    ]);
    return store;
  }

  it("personal watch fires only on the owner's tasks (assigned to OR created by)", async () => {
    const res = await evaluate(makeCtx(setup("personal", "agent")));
    expect(res.fired_count).toBe(1);
    // owner 'agent' owns the created-by and assigned-to tasks (2), not doug's (3rd).
    expect(String(res.fired[0].brief)).toContain("2 overdue");
  });

  it("org watch evaluates company-wide (all three)", async () => {
    const res = await evaluate(makeCtx(setup("org", null)));
    expect(String(res.fired[0].brief)).toContain("3 overdue");
  });
});

describe("resolve_trigger_fire — interactive drain marks acted / dismissed", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new Map<string, Row[]>();
    store.set("trigger_fires", [
      {
        id: "fire-1", company_id: "default", trigger_id: "trg-od",
        condition_type: "overdue_task", brief: "1 overdue task", fingerprint: "fp",
        action: {}, status: "pending", acted_at: null, acted_by: null,
      },
    ]);
    ctx = makeCtx(store);
  });

  it("marks a pending fire acted and drops it from the pending list", async () => {
    const res = await resolveFire(ctx, { fire_id: "fire-1", status: "acted" });
    expect(res.success).toBe(true);
    expect(res.fire.status).toBe("acted");

    const row = (store.get("trigger_fires") ?? [])[0];
    expect(row.status).toBe("acted");
    expect(row.acted_at).toBeTruthy();
    expect(row.acted_by).toBe("agent");

    const pending = await listFires(ctx, {});
    expect(pending.count).toBe(0);
  });

  it("dismisses a fire as noise", async () => {
    const res = await resolveFire(ctx, { fire_id: "fire-1", status: "dismissed", note: "expected, ignore" });
    expect(res.fire.status).toBe("dismissed");
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("dismissed");
  });

  it("throws when the fire does not exist", async () => {
    await expect(resolveFire(ctx, { fire_id: "00000000-0000-0000-0000-000000000000", status: "acted" }))
      .rejects.toThrow(/not found/i);
  });

  it("does not resolve a fire belonging to another company", async () => {
    store.get("trigger_fires")![0].company_id = "other-co";
    await expect(resolveFire(ctx, { fire_id: "fire-1", status: "acted" })).rejects.toThrow(/not found/i);
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("pending");
  });
});
