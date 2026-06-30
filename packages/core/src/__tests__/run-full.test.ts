// ============================================================
// Founders OS — Autonomous runner: full (model-driven) mode
// ============================================================
// Drives runFull against an in-memory DB and a scripted MockAgentModel
// (no network). Asserts the full-run contract:
//   * a scripted create_task is performed (internal, reversible);
//   * a scripted external preview_action is STAGED, never executed;
//   * a forbidden tool (execute_action) is not in the map and is never
//     dispatched;
//   * the global maxActions budget and per-fire maxStepsPerFire cap hold;
//   * the pause kill switch returns early;
//   * every processed fire ends 'acted'.
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { runFull } from "../tools/run/full.js";
import { buildAgentToolRegistry } from "../agent/allowlist.js";
import { MockAgentModel, type AgentTurn } from "../agent/model.js";
import type { ToolContext } from "../types/context.js";

beforeAll(() => {
  process.env.FOUNDERS_OS_SIGNING_SECRET = "run-full-test-secret";
});

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
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
  is(c: string, v: null): this { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  order(c: string): this { this.orderCol = c; return this; }
  limit(n: number): this { this.limitN = n; return this; }
  or(): this { return this; }

  update(p: Row): this { this.op = "update"; this.patch = p; return this; }
  delete(): this { this.op = "delete"; return this; }
  insert(p: Row | Row[]): this {
    this.op = "insert";
    for (const row of Array.isArray(p) ? p : [p]) {
      const withId = { id: row.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...row };
      this.rows().push(withId);
      this.inserted.push(withId);
    }
    return this;
  }

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "insert") return { data: this.inserted[0] ? { ...this.inserted[0] } : null, error: null };
    return { data: this.matched()[0] ? { ...this.matched()[0] } : null, error: null };
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
    if (this.op === "delete") {
      const all = this.rows();
      const removed = this.matched();
      const keep = all.filter((r) => !removed.includes(r));
      this.store.set(this.table, keep);
      return resolve({ data: removed.map((r) => ({ ...r })), error: null });
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

  // Models acquire_agent_run_lock (migration 041): claim when free or the
  // existing lock is stale; refuse when a fresh lock is held by another run.
  async rpc(name: string, params: Record<string, unknown>): Promise<{ data: unknown; error: null }> {
    if (name === "acquire_agent_run_lock") {
      const locks = this.store.get("agent_run_locks") ?? [];
      this.store.set("agent_run_locks", locks);
      const existing = locks.find((l) => l.company_id === params.p_company_id);
      const ttlMs = (Number(params.p_ttl_seconds) || 3600) * 1000;
      if (!existing) {
        locks.push({ company_id: params.p_company_id, run_id: params.p_run_id, locked_at: new Date().toISOString() });
        return { data: true, error: null };
      }
      const fresh = Date.now() - new Date(String(existing.locked_at)).getTime() < ttlMs;
      if (fresh && existing.run_id !== params.p_run_id) return { data: false, error: null };
      existing.run_id = params.p_run_id;
      existing.locked_at = new Date().toISOString();
      return { data: true, error: null };
    }
    return { data: null, error: null };
  }
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
    actor: { kind: "autonomous", runId: "run-full-1" },
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

function seedFires(store: Map<string, Row[]>, n = 1): void {
  const fires: Row[] = [];
  for (let i = 0; i < n; i++) {
    fires.push({
      id: `fire-${i}`, company_id: "default", trigger_id: `trg-${i}`,
      condition_type: "overdue_task", brief: `${i + 1} overdue tasks`,
      fingerprint: `fp-${i}`, action: {}, status: "pending",
      created_at: new Date(Date.now() + i).toISOString(),
    });
  }
  store.set("trigger_fires", fires);
}

const createTaskCall = (id: string, title: string): AgentTurn => ({
  toolCalls: [{ id, name: "create_task", input: { title } }],
  stop: "tool_use",
});
const externalPreviewCall = (id: string): AgentTurn => ({
  toolCalls: [
    {
      id,
      name: "preview_action",
      input: {
        action: { kind: "external", connector: "slack", action: "send_message", params: { channel: "#ops", text: "FYI" } },
        source: "trigger:trg-0",
      },
    },
  ],
  stop: "tool_use",
});
const done: AgentTurn = { toolCalls: [], stop: "end" };

describe("runFull — model-driven inbox drain", () => {
  let store: Map<string, Row[]>;
  let ctx: ToolContext;
  beforeEach(() => {
    store = new Map<string, Row[]>();
    seedFires(store, 1);
    ctx = autonomousCtx(store);
  });

  it("performs a scripted create_task and marks the fire acted", async () => {
    const model = new MockAgentModel([createTaskCall("c1", "Follow up on overdue work"), done]);
    const res = await runFull(ctx, { model });

    expect(res.created).toBe(1);
    expect(res.staged).toBe(0);
    expect(res.skipped).toBe(0);
    const tasks = store.get("tasks") ?? [];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Follow up on overdue work");
    const fire = (store.get("trigger_fires") ?? [])[0];
    expect(fire.status).toBe("acted");
    expect(String(fire.acted_by)).toContain("autonomous-run");
  });

  it("stages a scripted external preview_action and never executes it", async () => {
    const model = new MockAgentModel([externalPreviewCall("p1"), done]);
    const res = await runFull(ctx, { model });

    expect(res.staged).toBe(1);
    const pending = store.get("pending_approvals") ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    // Nothing was executed: no approval row flipped to executed.
    expect(pending.filter((r) => r.status === "executed")).toHaveLength(0);
  });

  it("never dispatches a forbidden tool the model tries to call", async () => {
    expect(Object.prototype.hasOwnProperty.call(buildAgentToolRegistry(), "execute_action")).toBe(false);
    const model = new MockAgentModel([
      { toolCalls: [{ id: "x", name: "execute_action", input: { confirm_token: "forged" } }], stop: "tool_use" },
      done,
    ]);
    const res = await runFull(ctx, { model });

    expect(res.created).toBe(0);
    expect(res.staged).toBe(0);
    expect(res.skipped).toBe(1); // model acted on nothing
    expect((store.get("pending_approvals") ?? [])).toHaveLength(0);
    // The fire is still drained so it does not reappear next session.
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("acted");
  });

  it("enforces the global maxActions budget", async () => {
    const model = new MockAgentModel([
      { toolCalls: [
        { id: "a", name: "create_task", input: { title: "first" } },
        { id: "b", name: "create_task", input: { title: "second" } },
      ], stop: "tool_use" },
      done,
    ]);
    const res = await runFull(ctx, { maxActions: 1, model });

    expect(res.created).toBe(1);
    expect(res.budget_exhausted).toBe(true);
    expect((store.get("tasks") ?? [])).toHaveLength(1);
  });

  it("caps the per-fire model loop at maxStepsPerFire", async () => {
    // The model keeps proposing tool calls; the loop must stop at the cap.
    const model = new MockAgentModel([
      createTaskCall("s1", "a"),
      createTaskCall("s2", "b"),
      createTaskCall("s3", "c"),
      createTaskCall("s4", "d"),
    ]);
    await runFull(ctx, { maxStepsPerFire: 2, maxActions: 10, model });
    expect(model.calls).toHaveLength(2);
    expect((store.get("tasks") ?? [])).toHaveLength(2);
  });

  it("processes every fire and marks them all acted", async () => {
    seedFires(store, 3);
    ctx = autonomousCtx(store);
    const model = new MockAgentModel([
      createTaskCall("f0", "t0"), done,
      createTaskCall("f1", "t1"), done,
      createTaskCall("f2", "t2"), done,
    ]);
    const res = await runFull(ctx, { model });
    expect(res.scanned).toBe(3);
    expect(res.created).toBe(3);
    for (const f of store.get("trigger_fires") ?? []) expect(f.status).toBe("acted");
  });
});

describe("runFull — guards", () => {
  it("does nothing when agents are paused company-wide", async () => {
    const store = new Map<string, Row[]>();
    seedFires(store, 1);
    store.set("guardrail_policy", [{ company_id: "default", tier_outcomes: {}, dry_run: false, paused: true }]);
    const ctx = autonomousCtx(store);
    const res = await runFull(ctx, { model: new MockAgentModel([done]) });

    expect(res.paused).toBe(true);
    expect(res.scanned).toBe(0);
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("pending");
  });

  it("throws when no model is configured and none injected", async () => {
    const store = new Map<string, Row[]>();
    seedFires(store, 1);
    const ctx = autonomousCtx(store);
    await expect(runFull(ctx)).rejects.toThrow(/requires an agent model/);
  });

  it("does nothing when another run holds a fresh company lock", async () => {
    const store = new Map<string, Row[]>();
    seedFires(store, 1);
    // A different run already holds a fresh lock.
    store.set("agent_run_locks", [
      { company_id: "default", run_id: "other-run", locked_at: new Date().toISOString() },
    ]);
    const ctx = autonomousCtx(store);
    const res = await runFull(ctx, { model: new MockAgentModel([createTaskCall("c", "x"), done]) });

    expect(res.locked_out).toBe(true);
    expect(res.scanned).toBe(0);
    expect((store.get("tasks") ?? [])).toHaveLength(0);
    expect((store.get("trigger_fires") ?? [])[0].status).toBe("pending");
    // The other run's lock is untouched.
    expect((store.get("agent_run_locks") ?? [])[0].run_id).toBe("other-run");
  });

  it("acquires and releases the lock around a normal run", async () => {
    const store = new Map<string, Row[]>();
    seedFires(store, 1);
    const ctx = autonomousCtx(store);
    const res = await runFull(ctx, { model: new MockAgentModel([createTaskCall("c", "t"), done]) });

    expect(res.locked_out).toBe(false);
    expect(res.created).toBe(1);
    // Lock released on completion so the next tick runs immediately.
    expect((store.get("agent_run_locks") ?? [])).toHaveLength(0);
  });
});
