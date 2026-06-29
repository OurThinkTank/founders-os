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
