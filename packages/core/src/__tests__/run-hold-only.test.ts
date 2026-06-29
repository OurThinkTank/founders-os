// ============================================================
// Founders OS — Autonomous runner: hold-only mode (integration)
// ============================================================
// Exercises runHoldOnly against an in-memory DB that models the chains
// the runner + preview_action use. Asserts the hold-only contract: every
// pending inbox fire is STAGED into the approval queue for human review,
// the fire is marked acted, and NOTHING is executed. Also asserts the
// pause kill switch stops the run cold.
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { runHoldOnly } from "../tools/run/hold-only.js";
import { governanceTools } from "../tools/governance/index.js";
import type { ToolContext } from "../types/context.js";

beforeAll(() => {
  process.env.FOUNDERS_OS_SIGNING_SECRET = "run-hold-only-test-secret";
});

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" = "select";
  private patch: Row | null = null;
  private inserted: Row[] = [];
  private orderCol: string | null = null;
  private limitN: number | null = null;

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
  limit(n: number): this { this.limitN = n; return this; }
  or(): this { return this; }

  update(p: Row): this { this.op = "update"; this.patch = p; return this; }
  insert(p: Row | Row[]): this {
    this.op = "insert";
    for (const row of Array.isArray(p) ? p : [p]) {
      const withId = { id: row.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...row };
      this.rows().push(withId);
      this.inserted.push(withId);
    }
    return this;
  }
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
    return { data: this.matched()[0] ? { ...this.matched()[0] } : null, error: null };
  }

  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    if (this.op === "insert") return resolve({ data: this.inserted.map((r) => ({ ...r })), error: null });
    if (this.op === "update") {
      const targets = this.matched();
      for (const t of targets) Object.assign(t, this.patch);
      return resolve({ data: targets.map((r) => ({ ...r })), error: null });
    }
    let rows = this.matched().map((r) => ({ ...r }));
    if (this.orderCol) rows = rows.sort((a, b) => String(a[this.orderCol!]).localeCompare(String(b[this.orderCol!])));
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    return resolve({ data: rows, error: null });
  }
}

class FakeDb {
  constructor(public store: Map<string, Row[]>) {}
  from(t: string): FakeQuery { return new FakeQuery(this.store, t); }
}

function autonomousCtx(store: Map<string, Row[]>): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"],
    admin: db as unknown as ToolContext["admin"],
    companyId: "default",
    userId: "runner",
    identityMode: "background",
    isSoloMode: true,
    actor: { kind: "autonomous", runId: "run-test-1" },
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

const listPending = (ctx: ToolContext) =>
  (governanceTools.list_pending_approvals.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, {});

function seedFire(store: Map<string, Row[]>): void {
  store.set("trigger_fires", [
    {
      id: "fire-1", company_id: "default", trigger_id: "trg-1", condition_type: "overdue_task",
      brief: "2 overdue tasks", fingerprint: "fp:abc",
      action: { action_type: "notify", action_params: { channel: "#ops", text: "Heads up: overdue work has slipped." } },
      status: "pending", created_at: new Date().toISOString(),
    },
  ]);
}

describe("runHoldOnly — stages inbox fires for review, performs nothing", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new Map<string, Row[]>();
    seedFire(store);
    ctx = autonomousCtx(store);
  });

  it("stages each pending fire into the approval queue and marks it acted", async () => {
    const res = await runHoldOnly(ctx);
    expect(res.paused).toBe(false);
    expect(res.scanned).toBe(1);
    expect(res.staged).toBe(1);

    // A staged approval row exists, pending a human, at a hold tier.
    const pending = store.get("pending_approvals") ?? [];
    expect(pending.length).toBe(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].tier).toBe("external_write");

    // The inbox fire is marked acted by the run.
    const fire = (store.get("trigger_fires") ?? [])[0];
    expect(fire.status).toBe("acted");
    expect(String(fire.acted_by)).toContain("autonomous-run");
  });

  it("performs nothing: no approval is executed by the run", async () => {
    await runHoldOnly(ctx);
    const executed = (store.get("pending_approvals") ?? []).filter((r) => r.status === "executed");
    expect(executed.length).toBe(0);
  });

  it("the staged item is visible on the review surface (list_pending_approvals)", async () => {
    await runHoldOnly(ctx);
    const listed = await listPending(ctx);
    expect(listed.count).toBe(1);
  });

  it("a second run does not re-stage an already-acted fire", async () => {
    await runHoldOnly(ctx);
    const second = await runHoldOnly(ctx);
    expect(second.scanned).toBe(0);
    expect((store.get("pending_approvals") ?? []).length).toBe(1);
  });
});

describe("runHoldOnly — pause kill switch", () => {
  it("does nothing when agents are paused company-wide", async () => {
    const store = new Map<string, Row[]>();
    seedFire(store);
    store.set("guardrail_policy", [{ company_id: "default", tier_outcomes: {}, dry_run: false, paused: true }]);
    const ctx = autonomousCtx(store);

    const res = await runHoldOnly(ctx);
    expect(res.paused).toBe(true);
    expect(res.scanned).toBe(0);
    // Nothing staged, fire left pending for a later (unpaused) run.
    expect((store.get("pending_approvals") ?? []).length).toBe(0);
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("pending");
  });
});
