// ============================================================
// Founders OS — Agent SDK session safety posture (T2.5)
// ============================================================
// runAgentSession behind the pause check, the per-company run lock, and the
// send budget, with the SDK call injected as a scripted fake query.
// ============================================================

import { describe, it, expect, beforeAll } from "vitest";
import { runAgentSession } from "../agent/session.js";
import { actionHash } from "../tools/governance/index.js";
import type { RunnerMessage, RunAgentTickOptions } from "../agent/runner.js";
import type { ToolContext } from "../types/context.js";

beforeAll(() => {
  process.env.FOUNDERS_OS_SIGNING_SECRET = "agent-session-test-secret";
});

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = [];
  private op: "select" | "update" | "insert" | "delete" = "select";
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
  order(c: string): this { this.orderCol = c; return this; }
  update(p: Row): this { this.op = "update"; this.patch = p; return this; }
  delete(): this { this.op = "delete"; return this; }
  insert(p: Row): this {
    this.op = "insert";
    const row = { id: p.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...p };
    this.rows().push(row); this.inserted.push(row); return this;
  }
  async upsert(payload: Row, opts: { onConflict: string }): Promise<{ error: null }> {
    const existing = this.rows().find((r) => r[opts.onConflict] === payload[opts.onConflict]);
    if (existing) Object.assign(existing, payload); else this.rows().push({ ...payload });
    return { error: null };
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "update") {
      const t = this.matched()[0];
      if (!t) return { data: null, error: null };
      Object.assign(t, this.patch); return { data: { ...t }, error: null };
    }
    return { data: this.matched()[0] ? { ...this.matched()[0] } : null, error: null };
  }
  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    if (this.op === "delete") {
      const removed = this.matched();
      this.store.set(this.table, this.rows().filter((r) => !removed.includes(r)));
      return resolve({ data: removed.map((r) => ({ ...r })), error: null });
    }
    let rows = this.matched().map((r) => ({ ...r }));
    if (this.orderCol) rows = rows.sort((a, b) => String(a[this.orderCol!]).localeCompare(String(b[this.orderCol!])));
    return resolve({ data: rows, error: null });
  }
}

class FakeDb {
  constructor(public store: Map<string, Row[]>) {}
  from(t: string): FakeQuery { return new FakeQuery(this.store, t); }
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
      existing.run_id = params.p_run_id; existing.locked_at = new Date().toISOString();
      return { data: true, error: null };
    }
    return { data: null, error: null };
  }
}

function ctxFor(store: Map<string, Row[]>): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"],
    admin: db as unknown as ToolContext["admin"],
    companyId: "default",
    userId: "runner",
    identityMode: "background",
    isSoloMode: true,
    actor: { kind: "autonomous", runId: "session-run-1" },
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

const baseConfig = {
  mcpServers: {},
  allowedTools: [],
  systemPrompt: "s",
  prompt: "p",
};

function seedClearance(store: Map<string, Row[]>, jti: string, text: string) {
  const hash = actionHash({ kind: "external", connector: "slack", action: "send_message", params: { text }, summary: null });
  const list = store.get("action_clearances") ?? [];
  list.push({
    company_id: "default", jti, action_hash: hash, connector: "slack",
    action_type: "external:slack:send_message", status: "cleared",
    cleared_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600000).toISOString(),
  });
  store.set("action_clearances", list);
}

describe("runAgentSession safety posture (T2.5)", () => {
  it("does nothing when agents are paused company-wide; the SDK is never called", async () => {
    const store = new Map<string, Row[]>();
    store.set("guardrail_policy", [{ company_id: "default", tier_outcomes: {}, dry_run: false, paused: true }]);
    let called = false;
    const fake = async function* (): AsyncIterable<RunnerMessage> { called = true; yield { type: "result", subtype: "success" }; };
    const res = await runAgentSession(ctxFor(store), baseConfig, fake);
    expect(res.paused).toBe(true);
    expect(called).toBe(false);
  });

  it("is locked out when another run holds the company lock; the SDK is never called", async () => {
    const store = new Map<string, Row[]>();
    store.set("agent_run_locks", [{ company_id: "default", run_id: "other-run", locked_at: new Date().toISOString() }]);
    let called = false;
    const fake = async function* (): AsyncIterable<RunnerMessage> { called = true; yield { type: "result", subtype: "success" }; };
    const res = await runAgentSession(ctxFor(store), baseConfig, fake);
    expect(res.locked_out).toBe(true);
    expect(called).toBe(false);
    // the other run's lock is untouched
    expect((store.get("agent_run_locks") ?? [])[0].run_id).toBe("other-run");
  });

  it("runs, returns the summary, and releases the lock on the way out", async () => {
    const store = new Map<string, Row[]>();
    const fake = async function* (): AsyncIterable<RunnerMessage> {
      yield { type: "tool_use", toolUse: { id: "1", name: "mcp__founders-os__create_task", input: {} } };
      yield { type: "tool_use", toolUse: { id: "2", name: "mcp__founders-os__resolve_trigger_fire", input: {} } };
      yield { type: "result", subtype: "success" };
    };
    const res = await runAgentSession(ctxFor(store), baseConfig, fake);
    expect(res.paused).toBe(false);
    expect(res.locked_out).toBe(false);
    expect(res.created).toBe(1);
    expect(res.resolved).toBe(1);
    expect((store.get("agent_run_locks") ?? [])).toHaveLength(0);
  });

  it("caps connector sends at the budget and reports budget_exhausted", async () => {
    const store = new Map<string, Row[]>();
    seedClearance(store, "ja", "a");
    seedClearance(store, "jb", "b");
    seedClearance(store, "jc", "c");
    // The fake drives the hook directly for three distinct slack sends.
    const fake = async function* (opts: RunAgentTickOptions): AsyncIterable<RunnerMessage> {
      for (const t of ["a", "b", "c"]) {
        await opts.canUseTool("mcp__slack__send_message", { text: t });
        yield { type: "tool_use", toolUse: { id: t, name: "mcp__slack__send_message", input: { text: t } } };
      }
      yield { type: "result", subtype: "success" };
    };
    const res = await runAgentSession(ctxFor(store), { ...baseConfig, maxSends: 2 }, fake);
    expect(res.sent).toBe(2);
    expect(res.budget_exhausted).toBe(true);
  });
});
