// ============================================================
// Founders OS — Data condition evaluator tests
// ============================================================
// Each data evaluator gets a matching and a non-matching fixture, run
// against a small in-memory DB that models the read chains the
// evaluators use. These assert real query behavior (which rows match,
// what the material state is), not just that the function returns.
// ============================================================

import { describe, it, expect } from "vitest";
import { dataEvaluators } from "../tools/triggers/conditions.js";
import type { ToolContext } from "../types/context.js";

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  constructor(private store: Map<string, Row[]>, private table: string) {}
  private rows(): Row[] { return this.store.get(this.table) ?? []; }
  select(_c?: string): this { return this; }
  eq(c: string, v: unknown): this { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]): this { this.filters.push((r) => vs.includes(r[c])); return this; }
  lt(c: string, v: unknown): this { this.filters.push((r) => r[c] != null && (r[c] as never) < (v as never)); return this; }
  gte(c: string, v: unknown): this { this.filters.push((r) => r[c] != null && (r[c] as never) >= (v as never)); return this; }
  is(c: string, v: null): this { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _o: "is", v: null): this { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    return resolve({ data: this.rows().filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r })), error: null });
  }
}
class FakeDb { constructor(public store: Map<string, Row[]>) {} from(t: string): FakeQuery { return new FakeQuery(this.store, t); } }
function ctxWith(store: Map<string, Row[]>): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"], admin: db as unknown as ToolContext["admin"],
    companyId: "default", userId: "agent", identityMode: "env", isSoloMode: true,
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}
function iso(daysAgo: number): string { return new Date(Date.now() - daysAgo * 86_400_000).toISOString(); }
function dateStr(daysFromToday: number): string { return new Date(Date.now() + daysFromToday * 86_400_000).toISOString().slice(0, 10); }

describe("overdue_task", () => {
  it("matches a task past its due date and not matches one due in the future", async () => {
    const matchStore = new Map<string, Row[]>([["tasks", [
      { id: "t1", company_id: "default", status: "todo", due_date: dateStr(-2), deleted_at: null },
    ]]]);
    const r = await dataEvaluators.overdue_task(ctxWith(matchStore), {});
    expect(r.matched).toBe(true);
    expect(r.rows.map((x) => x.id)).toContain("t1");

    const noStore = new Map<string, Row[]>([["tasks", [
      { id: "t2", company_id: "default", status: "todo", due_date: dateStr(+3), deleted_at: null },
    ]]]);
    expect((await dataEvaluators.overdue_task(ctxWith(noStore), {})).matched).toBe(false);
  });
});

describe("stalled_deal", () => {
  it("matches a pipeline customer with no movement, not a terminal-phase or fresh one", async () => {
    const store = new Map<string, Row[]>([["customers", [
      { id: "c1", company_id: "default", customer_phase: "opportunity", updated_at: iso(20), deleted_at: null },
      { id: "c2", company_id: "default", customer_phase: "customer", updated_at: iso(40), deleted_at: null }, // terminal phase
      { id: "c3", company_id: "default", customer_phase: "lead", updated_at: iso(1), deleted_at: null },       // fresh
    ]]]);
    const r = await dataEvaluators.stalled_deal(ctxWith(store), { days: 14 });
    expect(r.matched).toBe(true);
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("c2");
    expect(ids).not.toContain("c3");
  });

  it("state field changes when a deal slips into a deeper bucket", async () => {
    const mk = (days: number) => new Map<string, Row[]>([["customers", [
      { id: "c1", company_id: "default", customer_phase: "opportunity", updated_at: iso(days), deleted_at: null },
    ]]]);
    const at15 = await dataEvaluators.stalled_deal(ctxWith(mk(15)), { days: 14 });
    const at40 = await dataEvaluators.stalled_deal(ctxWith(mk(40)), { days: 14 });
    expect(at15.state_field).not.toBe(at40.state_field);
  });
});

describe("overspend (rolling window, expense categories only)", () => {
  function financeStore(amount: number, catType: "expense" | "income"): Map<string, Row[]> {
    return new Map<string, Row[]>([
      ["financial_categories", [
        { id: "cat-e", company_id: "default", type: catType, archived: false, deleted_at: null },
      ]],
      ["financial_transactions", [
        { id: "tx1", company_id: "default", category_id: "cat-e", amount, date: dateStr(-2), archived: false, exclude_from_reports: false, deleted_at: null },
      ]],
    ]);
  }
  it("matches when expense in the window crosses the threshold", async () => {
    const r = await dataEvaluators.overspend(ctxWith(financeStore(50, "expense")), { window_days: 30, threshold_cents: 1000 });
    expect(r.matched).toBe(true); // $50.00 = 5000c >= 1000c
    expect(r.state_field).toBe("step:5");
  });
  it("does not match income-category spend or below-threshold spend", async () => {
    expect((await dataEvaluators.overspend(ctxWith(financeStore(50, "income")), { window_days: 30, threshold_cents: 1000 })).matched).toBe(false);
    expect((await dataEvaluators.overspend(ctxWith(financeStore(5, "expense")), { window_days: 30, threshold_cents: 1000 })).matched).toBe(false); // 500c < 1000c
  });
});

describe("budget_threshold (month-to-date)", () => {
  it("matches month-to-date expense over budget", async () => {
    const store = new Map<string, Row[]>([
      ["financial_categories", [{ id: "cat-e", company_id: "default", type: "expense", archived: false, deleted_at: null }]],
      ["financial_transactions", [
        { id: "tx1", company_id: "default", category_id: "cat-e", amount: 30, date: dateStr(0), archived: false, exclude_from_reports: false, deleted_at: null },
      ]],
    ]);
    const r = await dataEvaluators.budget_threshold(ctxWith(store), { threshold_cents: 1000 });
    expect(r.matched).toBe(true);
  });
});
