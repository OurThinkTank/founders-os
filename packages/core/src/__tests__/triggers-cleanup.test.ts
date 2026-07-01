// ============================================================
// Founders OS — Trigger cascade cleanup + playbook authorship
// ============================================================
// Asserts the spec's testable guarantee: no enabled trigger survives the
// removal of the entity it watches. Also covers playbook-authored
// provenance (created_by = 'playbook:<run-id>').
// ============================================================

import { describe, it, expect } from "vitest";
import { cascadeTriggersForEntity, dismissFiresForTriggers } from "../tools/triggers/cleanup.js";
import { triggerTools } from "../tools/triggers/index.js";
import type { ToolContext } from "../types/context.js";

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row | null = null;
  private inserted: Row[] = [];
  constructor(private store: Map<string, Row[]>, private table: string) {}
  private rows(): Row[] { if (!this.store.has(this.table)) this.store.set(this.table, []); return this.store.get(this.table)!; }
  private matched(): Row[] { return this.rows().filter((r) => this.filters.every((f) => f(r))); }
  select(_c?: string): this { if (this.op === "select") this.op = "select"; return this; }
  eq(c: string, v: unknown): this { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]): this { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null): this { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  update(p: Row): this { this.op = "update"; this.patch = p; return this; }
  insert(p: Row): this { this.op = "insert"; const row = { id: p.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...p }; this.rows().push(row); this.inserted.push(row); return this; }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "insert") return { data: this.inserted[0] ?? null, error: null };
    if (this.op === "update") { const t = this.matched()[0]; if (t) Object.assign(t, this.patch); return { data: t ? { ...t } : null, error: null }; }
    const f = this.matched()[0]; return { data: f ? { ...f } : null, error: null };
  }
  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    if (this.op === "update") { const m = this.matched(); for (const r of m) Object.assign(r, this.patch); return resolve({ data: m.map((r) => ({ ...r })), error: null }); }
    return resolve({ data: this.matched().map((r) => ({ ...r })), error: null });
  }
}
class FakeDb { constructor(public store: Map<string, Row[]>) {} from(t: string): FakeQuery { return new FakeQuery(this.store, t); } }
function ctxWith(store: Map<string, Row[]>): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"], admin: db as unknown as ToolContext["admin"],
    companyId: "default", userId: "doug", identityMode: "env", isSoloMode: true,
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

describe("cascadeTriggersForEntity", () => {
  it("soft-deletes and disables triggers bound to the entity, leaving others", async () => {
    const store = new Map<string, Row[]>([["triggers", [
      { id: "t1", company_id: "default", bound_entity_type: "customer", bound_entity_id: "cust-1", enabled: true, deleted_at: null },
      { id: "t2", company_id: "default", bound_entity_type: "customer", bound_entity_id: "cust-1", enabled: true, deleted_at: null },
      { id: "t3", company_id: "default", bound_entity_type: "customer", bound_entity_id: "cust-2", enabled: true, deleted_at: null },
      { id: "t4", company_id: "default", bound_entity_type: null, bound_entity_id: null, enabled: true, deleted_at: null },
    ]]]);
    const ctx = ctxWith(store);

    const removed = await cascadeTriggersForEntity(ctx, "customer", "cust-1");
    expect(removed).toBe(2);

    const rows = store.get("triggers")!;
    const survivingEnabled = rows.filter((r) => r.bound_entity_id === "cust-1" && r.enabled === true && r.deleted_at === null);
    expect(survivingEnabled).toHaveLength(0); // no enabled trigger survives
    // Other customers' and unbound triggers are untouched.
    expect(rows.find((r) => r.id === "t3")!.enabled).toBe(true);
    expect(rows.find((r) => r.id === "t4")!.enabled).toBe(true);
  });

  it("is a no-op (returns 0) when nothing is bound to the entity", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    expect(await cascadeTriggersForEntity(ctxWith(store), "playbook_run", "run-x")).toBe(0);
  });

  it("dismisses the removed triggers' pending inbox fires, leaving other watches' fires", async () => {
    const store = new Map<string, Row[]>([
      ["triggers", [
        { id: "t1", company_id: "default", bound_entity_type: "customer", bound_entity_id: "cust-1", enabled: true, deleted_at: null },
        { id: "t3", company_id: "default", bound_entity_type: "customer", bound_entity_id: "cust-2", enabled: true, deleted_at: null },
      ]],
      ["trigger_fires", [
        { id: "f1", company_id: "default", trigger_id: "t1", status: "pending" },
        { id: "f3", company_id: "default", trigger_id: "t3", status: "pending" },
      ]],
    ]);
    const ctx = ctxWith(store);

    await cascadeTriggersForEntity(ctx, "customer", "cust-1");

    const fires = store.get("trigger_fires")!;
    expect(fires.find((f) => f.id === "f1")!.status).toBe("dismissed"); // removed watch's fire cleared
    expect(fires.find((f) => f.id === "f3")!.status).toBe("pending");   // other watch untouched
  });
});

describe("dismissFiresForTriggers", () => {
  it("dismisses only pending fires for the given triggers and is a no-op on empty input", async () => {
    const store = new Map<string, Row[]>([["trigger_fires", [
      { id: "f1", company_id: "default", trigger_id: "t1", status: "pending" },
      { id: "f2", company_id: "default", trigger_id: "t1", status: "acted" },
      { id: "f3", company_id: "default", trigger_id: "t2", status: "pending" },
    ]]]);
    const ctx = ctxWith(store);

    expect(await dismissFiresForTriggers(ctx, [])).toBe(0);

    const n = await dismissFiresForTriggers(ctx, ["t1"]);
    expect(n).toBe(1); // only the pending f1
    const fires = store.get("trigger_fires")!;
    expect(fires.find((f) => f.id === "f1")!.status).toBe("dismissed");
    expect(fires.find((f) => f.id === "f1")!.acted_by).toBe("trigger-removed");
    expect(fires.find((f) => f.id === "f2")!.status).toBe("acted");   // already-acted untouched
    expect(fires.find((f) => f.id === "f3")!.status).toBe("pending"); // other trigger untouched
  });
});

describe("delete_trigger clears its inbox fires", () => {
  it("soft-deletes the trigger and dismisses its pending fire", async () => {
    const store = new Map<string, Row[]>([
      ["triggers", [{ id: "t1", company_id: "default", enabled: true, deleted_at: null }]],
      ["trigger_fires", [{ id: "f1", company_id: "default", trigger_id: "t1", status: "pending" }]],
    ]);
    const ctx = ctxWith(store);
    const del = triggerTools.delete_trigger.handler as (c: ToolContext, p: unknown) => Promise<any>;

    const res = await del(ctx, { trigger_id: "t1" });
    expect(res.success).toBe(true);
    expect(res.dismissed_fires).toBe(1);
    expect(store.get("triggers")!.find((t) => t.id === "t1")!.deleted_at).not.toBeNull();
    expect(store.get("trigger_fires")!.find((f) => f.id === "f1")!.status).toBe("dismissed");
  });
});

describe("create_trigger playbook authorship", () => {
  it("records created_by as 'playbook:<run-id>' when source_run_id is supplied", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    const ctx = ctxWith(store);
    const create = (triggerTools.create_trigger.handler as (c: ToolContext, p: unknown) => Promise<any>);
    const res = await create(ctx, {
      name: "Watch first invoice",
      condition_type: "overdue_invoice",
      condition_source: "connector",
      connector: "stripe",
      params: { days: 1 },
      action_type: "notify",
      bound_entity_type: "customer",
      bound_entity_id: "11111111-1111-1111-1111-111111111111",
      source_run_id: "22222222-2222-2222-2222-222222222222",
    });
    expect(res.success).toBe(true);
    expect(store.get("triggers")![0].created_by).toBe("playbook:22222222-2222-2222-2222-222222222222");
  });

  it("defaults created_by to the caller identity without source_run_id", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    const ctx = ctxWith(store);
    const create = (triggerTools.create_trigger.handler as (c: ToolContext, p: unknown) => Promise<any>);
    await create(ctx, { name: "Stuck tasks", condition_type: "stuck_task", action_type: "notify", params: { days: 7 } });
    expect(store.get("triggers")![0].created_by).toBe("doug");
  });
});

describe("create_trigger scope/owner (M3)", () => {
  const create = (triggerTools.create_trigger.handler as (c: ToolContext, p: unknown) => Promise<any>);

  it("defaults owner_id to the creator for a personal task watch, with no note", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    const res = await create(ctxWith(store), {
      name: "My overdue", condition_type: "overdue_task", action_type: "notify", scope: "personal",
    });
    expect(res.success).toBe(true);
    expect(res.note).toBeUndefined();
    expect(store.get("triggers")![0].scope).toBe("personal");
    expect(store.get("triggers")![0].owner_id).toBe("doug"); // ctxWith userId
  });

  it("returns a presentation-only note for a personal deal/spend watch", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    const res = await create(ctxWith(store), {
      name: "Spend watch", condition_type: "overspend", action_type: "notify", scope: "personal",
      params: { threshold_cents: 100000 },
    });
    expect(String(res.note)).toContain("company-wide");
    expect(store.get("triggers")![0].scope).toBe("personal");
  });

  it("org scope leaves owner_id null and emits no note", async () => {
    const store = new Map<string, Row[]>([["triggers", []]]);
    const res = await create(ctxWith(store), {
      name: "Team overdue", condition_type: "overdue_task", action_type: "notify",
    });
    expect(res.note).toBeUndefined();
    expect(store.get("triggers")![0].owner_id ?? null).toBeNull();
  });
});
