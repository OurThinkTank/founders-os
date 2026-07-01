// ============================================================
// Founders OS — Notifications inbox tools
// ============================================================
// Exercises notify_inbox / list_notifications / mark_notifications_read
// against an in-memory DB. Asserts: notify_inbox stamps the principal
// into created_by (autonomous-run:<runId> for the unattended agent),
// list defaults to unread, and mark clears read_at.
// ============================================================

import { describe, it, expect, beforeEach } from "vitest";
import { notificationTools } from "../tools/notifications/index.js";
import type { ToolContext } from "../types/context.js";

type Row = Record<string, unknown>;

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
  in(c: string, vs: unknown[]): this { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: null): this { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  order(c: string): this { this.orderCol = c; return this; }

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

  async single(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "insert") return { data: this.inserted[0] ? { ...this.inserted[0] } : null, error: null };
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
    if (this.orderCol) rows = rows.sort((a, b) => String(b[this.orderCol!]).localeCompare(String(a[this.orderCol!])));
    return resolve({ data: rows, error: null });
  }
}

class FakeDb {
  constructor(public store: Map<string, Row[]>) {}
  from(t: string): FakeQuery { return new FakeQuery(this.store, t); }
}

function ctxFor(store: Map<string, Row[]>, actor: ToolContext["actor"]): ToolContext {
  const db = new FakeDb(store);
  return {
    db: db as unknown as ToolContext["db"],
    admin: db as unknown as ToolContext["admin"],
    companyId: "default",
    userId: "vince",
    identityMode: actor?.kind === "autonomous" ? "background" : "env",
    isSoloMode: true,
    actor,
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  };
}

const notify = (ctx: ToolContext, p: unknown) =>
  (notificationTools.notify_inbox.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, p);
const list = (ctx: ToolContext, p: unknown = {}) =>
  (notificationTools.list_notifications.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, p);
const markRead = (ctx: ToolContext, p: unknown = {}) =>
  (notificationTools.mark_notifications_read.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, p);

describe("notify_inbox — principal stamping", () => {
  let store: Map<string, Row[]>;
  beforeEach(() => { store = new Map<string, Row[]>(); });

  it("stamps created_by as autonomous-run:<runId> for the unattended agent", async () => {
    const ctx = ctxFor(store, { kind: "autonomous", runId: "run-9" });
    const res = await notify(ctx, { title: "Stripe webhook failing", level: "warning" });
    expect(res.success).toBe(true);
    expect(res.notification.created_by).toBe("autonomous-run:run-9");
    expect(res.notification.source).toBe("autonomous-run:run-9");
    expect(res.notification.level).toBe("warning");
  });

  it("stamps created_by as the user id for an interactive session and defaults level to info", async () => {
    const ctx = ctxFor(store, { kind: "interactive", userId: "vince" });
    const res = await notify(ctx, { title: "Heads up" });
    expect(res.notification.created_by).toBe("vince");
    expect(res.notification.level).toBe("info");
  });

  it("honors an explicit source override", async () => {
    const ctx = ctxFor(store, { kind: "autonomous", runId: "run-9" });
    const res = await notify(ctx, { title: "From a watch", source: "trigger:trg-1" });
    expect(res.notification.source).toBe("trigger:trg-1");
  });
});

describe("list_notifications + mark_notifications_read", () => {
  let store: Map<string, Row[]>;
  let agent: ToolContext;
  let human: ToolContext;
  beforeEach(() => {
    store = new Map<string, Row[]>();
    agent = ctxFor(store, { kind: "autonomous", runId: "run-1" });
    human = ctxFor(store, { kind: "interactive", userId: "vince" });
  });

  it("defaults to unread and includes everything under status 'all'", async () => {
    await notify(agent, { title: "one" });
    await notify(agent, { title: "two" });
    const unread = await list(human);
    expect(unread.count).toBe(2);

    await markRead(human, { ids: [unread.notifications[0].id] });

    const stillUnread = await list(human);
    expect(stillUnread.count).toBe(1);
    const all = await list(human, { status: "all" });
    expect(all.count).toBe(2);
  });

  it("mark with no ids clears every unread notification", async () => {
    await notify(agent, { title: "a" });
    await notify(agent, { title: "b" });
    const res = await markRead(human);
    expect(res.marked_read).toBe(2);
    expect((await list(human)).count).toBe(0);
  });

  it("carries a render block with a markdown fallback", async () => {
    await notify(agent, { title: "render me" });
    const out = await list(human);
    expect(out.render.tier_1.format_hint).toBe("status_groups");
    expect(out.render.tier_3.markdown).toContain("render me");
  });
});
