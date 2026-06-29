// ============================================================
// Founders OS — Governance gate handshake (integration, in-memory DB)
// ============================================================
// Exercises the REAL tool handlers (preview_action, execute_action,
// approve_action, set_policy, pause_agents) against a small in-memory
// stand-in for the Supabase client that faithfully models the exact
// query chains the handlers use. This tests behavior, not just shape:
//   - external_write is held, not auto-run
//   - a held action cannot execute before approval
//   - approve_action (a human, not the agent) approves and reissues a token
//   - execute_action clears exactly once; a second attempt is refused (replay)
//   - a rejected action cannot run
//   - paused returns the paused outcome and records no pending row
//   - execute_action refuses a token whose action was altered (hash mismatch)
//   - approve_action IS registered (human interactive sessions need it)
//   - approve_action enforces a non-empty approver_id so self-approval is auditable
// ============================================================

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  governanceTools,
  autonomousGovernanceTools,
  approveAction,
  bulkApproveActions,
  registerGovernanceTools,
} from "../tools/governance/index.js";
import type { ToolContext } from "../types/context.js";

beforeAll(() => {
  process.env.FOUNDERS_OS_SIGNING_SECRET = "gate-test-secret";
});

// ── Minimal in-memory Supabase stand-in ────────────────────
// Supports exactly the chains the governance handlers call.

type Row = Record<string, unknown>;

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private op: "select" | "update" | null = null;
  private updatePayload: Row | null = null;

  constructor(private store: Map<string, Row[]>, private table: string) {}

  private rows(): Row[] {
    if (!this.store.has(this.table)) this.store.set(this.table, []);
    return this.store.get(this.table)!;
  }
  private matches(r: Row): boolean {
    return this.filters.every(([k, v]) => r[k] === v);
  }

  select(_cols?: string): this {
    if (this.op === null) this.op = "select";
    return this;
  }
  eq(k: string, v: unknown): this {
    this.filters.push([k, v]);
    return this;
  }
  update(payload: Row): this {
    this.op = "update";
    this.updatePayload = payload;
    return this;
  }

  private inserted: Row[] = [];

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.op === "insert") return { data: this.inserted[0] ? { ...this.inserted[0] } : null, error: null };
    if (this.op === "update") {
      const target = this.rows().find((r) => this.matches(r));
      if (!target) return { data: null, error: null };
      Object.assign(target, this.updatePayload);
      return { data: { ...target }, error: null };
    }
    const found = this.rows().find((r) => this.matches(r));
    return { data: found ? { ...found } : null, error: null };
  }

  private orderCol: string | null = null;
  order(col: string): this { this.orderCol = col; return this; }

  // Chainable insert so insert(...).select(...).maybeSingle() works.
  insert(payload: Row): this {
    this.op = "insert";
    const row = { id: payload.id ?? `gen-${Math.random().toString(36).slice(2)}`, ...payload };
    this.rows().push(row);
    this.inserted.push(row);
    return this;
  }

  // Awaiting the builder directly (no maybeSingle) resolves the terminal:
  // applies a pending update, or returns the insert/select result.
  then<R>(resolve: (v: { data: Row[]; error: null }) => R): R {
    if (this.op === "update") {
      const m = this.rows().filter((r) => this.matches(r));
      for (const r of m) Object.assign(r, this.updatePayload);
      return resolve({ data: m.map((r) => ({ ...r })), error: null });
    }
    if (this.op === "insert") return resolve({ data: this.inserted.map((r) => ({ ...r })), error: null });
    return resolve({ data: this.rows().filter((r) => this.matches(r)).map((r) => ({ ...r })), error: null });
  }

  async upsert(payload: Row, opts: { onConflict: string }): Promise<{ error: null }> {
    const key = opts.onConflict;
    const existing = this.rows().find((r) => r[key] === payload[key]);
    if (existing) Object.assign(existing, payload);
    else this.rows().push({ ...payload });
    return { error: null };
  }
}

class FakeDb {
  constructor(public store: Map<string, Row[]>) {}
  from(table: string): FakeQuery {
    return new FakeQuery(this.store, table);
  }
}

function makeCtx(): ToolContext {
  const store = new Map<string, Row[]>();
  const db = new FakeDb(store);
  const admin = new FakeDb(store); // audit_log lands in the same store
  return {
    db: db as unknown as ToolContext["db"],
    admin: admin as unknown as ToolContext["admin"],
    companyId: "default",
    userId: "agent-session",
    identityMode: "env",
    isSoloMode: true,
    embedding: {
      provider: "openai",
      model: "x",
      dimensions: 1,
      rateLimit: { maxCalls: 1, windowMs: 1 },
    },
  };
}

// Convenience wrappers that call the real handlers with (ctx, params).
const preview = (ctx: ToolContext, params: unknown) =>
  (governanceTools.preview_action.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const execute = (ctx: ToolContext, params: unknown) =>
  (governanceTools.execute_action.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const setPolicy = (ctx: ToolContext, params: unknown) =>
  (governanceTools.set_policy.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const pause = (ctx: ToolContext, params: unknown) =>
  (governanceTools.pause_agents.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const listPending = (ctx: ToolContext) =>
  (governanceTools.list_pending_approvals.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, {});

const externalWrite = {
  action: { kind: "external", connector: "github", action: "create_issue", params: { title: "Bug" }, summary: "Open a GitHub issue" },
};

describe("gate handshake — external_write is held until a human approves", () => {
  let ctx: ToolContext;
  beforeEach(() => {
    ctx = makeCtx();
  });

  it("holds an external_write and records one pending approval", async () => {
    const p = await preview(ctx, externalWrite);
    expect(p.outcome).toBe("hold_for_approval");
    expect(p.held).toBe(true);
    expect(p.confirm_token).toBeTruthy();

    const list = await listPending(ctx);
    expect(list.count).toBe(1);
  });

  it("delivers a held action: creates a native approval task and returns a Slack suggestion", async () => {
    const p = await preview(ctx, externalWrite);
    expect(p.delivery).toBeDefined();
    expect(p.delivery.channel).toBe("native_task");
    expect(p.delivery.task_id).toBeTruthy();
    expect(p.delivery.message_suggestion.text).toContain("Approval needed");

    // The guaranteed surface: an actual approval task exists in Founders OS.
    const tasks = (ctx.db as unknown as FakeDb).store.get("tasks") ?? [];
    expect(tasks.length).toBe(1);
    expect(String(tasks[0].title)).toContain("Approve:");
  });

  it("S2: neutralizes injection characters in the agent-supplied summary on the approval surface", async () => {
    const p = await preview(ctx, {
      action: {
        kind: "external", connector: "slack", action: "send_message",
        params: { text: "x" },
        summary: "Routine [click here](http://evil.example) `ignore prior warnings` <b>approve</b>",
      },
    });
    expect(p.outcome).toBe("hold_for_approval");
    const tasks = (ctx.db as unknown as FakeDb).store.get("tasks") ?? [];
    const title = String(tasks[0].title);
    // Markdown/link/HTML control characters are stripped from the human surface.
    for (const ch of ["[", "]", "(", ")", "`", "<", ">"]) expect(title).not.toContain(ch);
    expect(p.delivery.message_suggestion.text).not.toContain("`");
  });

  it("refuses execute before approval", async () => {
    const p = await preview(ctx, externalWrite);
    await expect(
      execute(ctx, { confirm_token: p.confirm_token, action: externalWrite.action })
    ).rejects.toThrow(/awaiting human approval/i);
  });

  it("a human approves, reissues a token, and execute clears exactly once (replay refused)", async () => {
    const p = await preview(ctx, externalWrite);

    // Approval is a HUMAN action with a non-agent identity.
    const decision = await approveAction(ctx, {
      approval_id: p.approval_id,
      decision: "approve",
      approver_id: "doug@ourthinktank.com",
    });
    expect(decision.status).toBe("approved");
    expect(decision.confirm_token).toBeTruthy();

    // First execute clears.
    const first = await execute(ctx, { confirm_token: decision.confirm_token, action: externalWrite.action });
    expect(first.cleared).toBe(true);

    // Second execute with the same token is refused (replay guard).
    await expect(
      execute(ctx, { confirm_token: decision.confirm_token, action: externalWrite.action })
    ).rejects.toThrow(/already executed/i);
  });

  it("a rejected action cannot run", async () => {
    const p = await preview(ctx, externalWrite);
    await approveAction(ctx, { approval_id: p.approval_id, decision: "reject", approver_id: "doug@ourthinktank.com" });
    await expect(
      execute(ctx, { confirm_token: p.confirm_token, action: externalWrite.action })
    ).rejects.toThrow(/rejected/i);
  });

  it("approve_action requires a human approver_id", async () => {
    const p = await preview(ctx, externalWrite);
    await expect(
      approveAction(ctx, { approval_id: p.approval_id, decision: "approve", approver_id: "" })
    ).rejects.toThrow(/approver/i);
  });
});

describe("gate handshake — execute_action binds to the exact previewed action", () => {
  it("refuses a token when the echoed action was altered", async () => {
    const ctx = makeCtx();
    const p = await preview(ctx, externalWrite);
    await approveAction(ctx, { approval_id: p.approval_id, decision: "approve", approver_id: "doug@ourthinktank.com" });
    const tampered = { ...externalWrite.action, params: { title: "Something else entirely" } };
    await expect(
      execute(ctx, { confirm_token: p.confirm_token, action: tampered })
    ).rejects.toThrow(/different action|hash mismatch/i);
  });
});

describe("gate handshake — allow tiers do not create a held row", () => {
  it("a read action is allowed and needs no approval", async () => {
    const ctx = makeCtx();
    const p = await preview(ctx, {
      action: { kind: "external", connector: "stripe", action: "list_invoices" },
    });
    expect(p.outcome).toBe("allow");
    expect(p.held).toBe(false);
    const cleared = await execute(ctx, {
      confirm_token: p.confirm_token,
      action: { kind: "external", connector: "stripe", action: "list_invoices" },
    });
    expect(cleared.cleared).toBe(true);
  });
});

describe("gate handshake — server-side template resolution (the withhold point)", () => {
  it("resolves {{placeholders}} server-side, classifies the resolved value, and round-trips resolved_action to execute", async () => {
    const ctx = makeCtx();
    // The caller passes a TEMPLATED message plus the context to resolve it.
    // Resolution happens inside preview_action, not in the caller.
    const p = await preview(ctx, {
      action: {
        kind: "external",
        connector: "slack",
        action: "send_message",
        params: { channel: "#x", text: "Reach our contact at {{customer.email}}" },
        summary: "Send a contact intro",
      },
      template_context: { customer: { email: "jane@acme.com" } },
    });

    // The resolved email makes this exfiltration, and it is held.
    expect(p.tier).toBe("exfiltration");
    expect(p.outcome).toBe("hold_for_approval");
    // The resolved action carries the real value, not the placeholder.
    expect(JSON.stringify(p.resolved_action)).toContain("jane@acme.com");
    expect(JSON.stringify(p.resolved_action)).not.toContain("{{");

    // Approve as a human, then execute with the echoed resolved_action.
    const decision = await approveAction(ctx, {
      approval_id: p.approval_id,
      decision: "approve",
      approver_id: "doug@ourthinktank.com",
    });
    const cleared = await execute(ctx, {
      confirm_token: decision.confirm_token,
      action: p.resolved_action,
    });
    expect(cleared.cleared).toBe(true);
  });

  it("refuses execute if the caller echoes the pre-resolution (templated) action", async () => {
    const ctx = makeCtx();
    const input = {
      kind: "external" as const,
      connector: "slack",
      action: "send_message",
      params: { channel: "#x", text: "Reach our contact at {{customer.email}}" },
      summary: "Send a contact intro",
    };
    const p = await preview(ctx, { action: input, template_context: { customer: { email: "jane@acme.com" } } });
    const decision = await approveAction(ctx, {
      approval_id: p.approval_id,
      decision: "approve",
      approver_id: "doug@ourthinktank.com",
    });
    // Echoing the templated input (not resolved_action) must fail the hash bind.
    await expect(
      execute(ctx, { confirm_token: decision.confirm_token, action: input })
    ).rejects.toThrow(/different action|hash mismatch/i);
  });
});

describe("gate handshake — pause kill switch", () => {
  it("returns paused and writes no pending row", async () => {
    const ctx = makeCtx();
    await pause(ctx, { paused: true });
    const p = await preview(ctx, externalWrite);
    expect(p.outcome).toBe("paused");
    expect(p.confirm_token).toBeUndefined();
    const list = await listPending(ctx);
    expect(list.count).toBe(0);
  });
});

describe("gate handshake — dry_run holds everything", () => {
  it("holds even a read action when dry_run is on", async () => {
    const ctx = makeCtx();
    await setPolicy(ctx, { dry_run: true });
    const p = await preview(ctx, {
      action: { kind: "external", connector: "stripe", action: "list_invoices" },
    });
    expect(p.outcome).toBe("hold_for_approval");
  });
});

describe("preview_action returns a structured risk breakdown (fix 4)", () => {
  it("surfaces the signals that drove an exfiltration classification", async () => {
    const ctx = makeCtx();
    const p = await preview(ctx, {
      action: { kind: "external", connector: "slack", action: "send_message", params: { text: "ping jane@acme.com about $9,000" } },
    });
    expect(p.risk_breakdown).toBeDefined();
    expect(p.risk_breakdown.tier).toBe("exfiltration");
    expect(p.risk_breakdown.signals.contact_emails).toContain("jane@acme.com");
    expect(p.risk_breakdown.signals.financial_values.length).toBeGreaterThan(0);
  });
});

describe("list_pending_approvals shows the resolved params (fix 2)", () => {
  it("returns action_params so the approver sees what would be sent", async () => {
    const ctx = makeCtx();
    await preview(ctx, externalWrite);
    const list = await listPending(ctx);
    expect(list.count).toBe(1);
    expect(list.pending[0].action_params).toBeDefined();
    expect(JSON.stringify(list.pending[0].action_params)).toContain("Bug");
  });
});

describe("set_policy can set paused (fix 3)", () => {
  it("pausing via set_policy makes preview return paused", async () => {
    const ctx = makeCtx();
    await setPolicy(ctx, { paused: true });
    const p = await preview(ctx, externalWrite);
    expect(p.outcome).toBe("paused");
  });
});

describe("set_policy refuses to lower a red tier", () => {
  it("rejects lowering destructive", async () => {
    const ctx = makeCtx();
    await expect(setPolicy(ctx, { tier_outcomes: { destructive: "allow" } })).rejects.toThrow(
      /cannot be lowered/i
    );
  });
});

const reconcile = (ctx: ToolContext, params: unknown) =>
  (governanceTools.reconcile_actions.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);
const listFindings = (ctx: ToolContext, params: unknown = {}) =>
  (governanceTools.list_reconciliation_findings.handler as (c: ToolContext, p: unknown) => Promise<any>)(ctx, params);

describe("dry-run bulk approve (human-channel)", () => {
  it("dry_run holds everything, then bulk approve clears the backlog in one human action", async () => {
    const ctx = makeCtx();
    await setPolicy(ctx, { dry_run: true });
    // Two safe reads that would normally pass, both held under dry-run.
    const a = await preview(ctx, { action: { kind: "external", connector: "stripe", action: "list_invoices" } });
    const b = await preview(ctx, { action: { kind: "external", connector: "github", action: "list_issues" } });
    expect(a.outcome).toBe("hold_for_approval");
    expect(b.outcome).toBe("hold_for_approval");
    expect((await listPending(ctx)).count).toBe(2);

    const res = (await bulkApproveActions(ctx, { approver_id: "doug@ourthinktank.com" })) as any;
    expect(res.decided).toBe(2);
    expect((await listPending(ctx)).count).toBe(0);

    // Each approved item now has a token and executes once.
    for (const r of res.results) {
      expect(r.status).toBe("approved");
      expect(r.confirm_token).toBeTruthy();
    }
  });

  it("requires a human approver_id", async () => {
    const ctx = makeCtx();
    await expect(bulkApproveActions(ctx, { approver_id: "" })).rejects.toThrow(/approver/i);
  });

  it("bulkApproveActions is not in the agent tool map", () => {
    expect(Object.keys(governanceTools)).not.toContain("bulk_approve_actions");
    expect(Object.keys(governanceTools)).not.toContain("bulkApproveActions");
  });
});

describe("reconcile — turns 'cannot prevent' into 'cannot hide'", () => {
  function seedExecuted(ctx: ToolContext) {
    const store = (ctx.db as unknown as FakeDb).store;
    store.set("pending_approvals", [
      { id: "ap-1", company_id: "default", jti: "j1", action_type: "external:slack:send_message", summary: "Posted renewal note", status: "executed" },
    ]);
  }

  it("matches a side effect stamped with the approval jti (exact)", async () => {
    const ctx = makeCtx();
    seedExecuted(ctx);
    const r = await reconcile(ctx, { connector: "slack", activities: [{ external_ref: "ts-100", jti: "j1", summary: "msg" }] });
    expect(r.matched).toBe(1);
    expect(r.ungoverned_count).toBe(0);
    expect(r.findings[0].matched_approval).toBe("ap-1");
  });

  it("flags an off-book side effect with no matching approval as ungoverned", async () => {
    const ctx = makeCtx();
    seedExecuted(ctx); // only a slack approval exists
    const r = await reconcile(ctx, { connector: "stripe", activities: [{ external_ref: "ch_1", summary: "charge created off-book" }] });
    expect(r.ungoverned_count).toBe(1);
    expect(r.findings[0].status).toBe("ungoverned");

    const list = await listFindings(ctx, { status: "ungoverned" });
    expect(list.count).toBe(1);
    expect(String(list.findings[0].connector)).toBe("stripe");
  });

  it("treats a jti that does not correspond to an executed approval as ungoverned", async () => {
    const ctx = makeCtx();
    seedExecuted(ctx);
    const r = await reconcile(ctx, { connector: "slack", activities: [{ external_ref: "ts-9", jti: "forged-or-unexecuted" }] });
    expect(r.ungoverned_count).toBe(1);
  });

  it("S1: consumes a matched approval so a reused jti on a second side effect is ungoverned", async () => {
    const ctx = makeCtx();
    seedExecuted(ctx); // exactly one executed approval, jti j1
    const r = await reconcile(ctx, { connector: "slack", activities: [
      { external_ref: "ts-1", jti: "j1" },
      { external_ref: "ts-2", jti: "j1" }, // same jti reused -> approval already consumed
    ]});
    expect(r.matched).toBe(1);
    expect(r.ungoverned_count).toBe(1);
  });

  it("S1: a no-jti side effect is UNVERIFIED (not matched), and only one per available approval", async () => {
    const ctx = makeCtx();
    seedExecuted(ctx); // one executed slack approval
    const r = await reconcile(ctx, { connector: "slack", activities: [
      { external_ref: "ts-a", summary: "msg a" },
      { external_ref: "ts-b", summary: "msg b" },
    ]});
    expect(r.matched).toBe(0);
    expect(r.unverified_count).toBe(1); // one approval consumed as unverified
    expect(r.ungoverned_count).toBe(1); // the second has nothing left to back it
  });
});

describe("approver-identity separation (the one real lever)", () => {
  it("approve_action IS registered so interactive human sessions (e.g. Cowork) can approve held actions", () => {
    expect(Object.keys(governanceTools)).toContain("approve_action");
  });

  it("registerGovernanceTools registers approve_action alongside the other tools", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => registered.push(name),
    } as never;
    registerGovernanceTools(fakeServer, makeCtx());
    expect(registered).toContain("preview_action");
    expect(registered).toContain("execute_action");
    expect(registered).toContain("approve_action");
  });

  it("approve_action enforces a non-empty human approver_id at the function level", async () => {
    // Autonomous agents are instructed not to call this tool. Any that do
    // anyway must supply a non-empty approver_id, making the self-approval
    // visible via reconcile_actions after the fact.
    const ctx = makeCtx();
    await expect(
      approveAction(ctx, { approval_id: "any", decision: "approve", approver_id: "" })
    ).rejects.toThrow(/approver/i);
  });
});

// ── Autonomous hard gate ───────────────────────────────────
// An autonomous (unattended) principal may never clear a human-decision
// action. preview refuses it (no token), execute re-checks ctx.actor at
// clear time, and the autonomous tool map withholds the control tools.

const makeAutonomousCtx = (): ToolContext => ({
  ...makeCtx(),
  actor: { kind: "autonomous", runId: "run-1" },
});

const externalRead = {
  action: { kind: "external", connector: "github", action: "get_issue", params: { id: 1 }, summary: "Read an issue" },
};
const externalDestructive = {
  action: { kind: "external", connector: "github", action: "delete_repo", params: { repo: "x" }, summary: "Delete a repo" },
};

describe("autonomous hard gate — preview stages hold tiers for deferred approval", () => {
  it("stages an external_write for an autonomous principal: no token, prepared payload queued", async () => {
    const ctx = makeAutonomousCtx();
    const res = await preview(ctx, externalWrite);
    expect(res.outcome).toBe("staged_for_deferred_approval");
    expect(res.staged).toBe(true);
    expect(res.confirm_token).toBeUndefined();
    // Queued for a human to approve/edit/reject later — a pending row exists,
    // and the full prepared action is echoed for the review surface.
    expect(res.approval_id).toBeTruthy();
    expect(res.resolved_action).toBeTruthy();
  });

  it("stages a destructive action for an autonomous principal", async () => {
    const res = await preview(makeAutonomousCtx(), externalDestructive);
    expect(res.outcome).toBe("staged_for_deferred_approval");
    expect(res.confirm_token).toBeUndefined();
  });

  it("does NOT stage a read action for an autonomous principal (only hold tiers stage)", async () => {
    const res = await preview(makeAutonomousCtx(), externalRead);
    expect(res.outcome).toBe("allow");
    expect(res.confirm_token).toBeTruthy();
  });
});

describe("autonomous hard gate — execute re-checks ctx.actor at clear time", () => {
  it("refuses to clear a hold-tier token presented by an autonomous principal", async () => {
    // A token legitimately minted in an interactive session...
    const human = makeCtx();
    const held = await preview(human, externalWrite);
    expect(held.outcome).toBe("hold_for_approval");
    // ...cannot be replayed by an autonomous runner to clear the hold.
    const auto = makeAutonomousCtx();
    await expect(
      execute(auto, { confirm_token: held.confirm_token, action: held.resolved_action })
    ).rejects.toThrow(/autonomous/i);
  });

  it("still clears an allow-tier token for an autonomous principal (gate only blocks holds)", async () => {
    const human = makeCtx();
    const allowed = await preview(human, externalRead);
    expect(allowed.outcome).toBe("allow");
    const res = await execute(makeAutonomousCtx(), {
      confirm_token: allowed.confirm_token,
      action: allowed.resolved_action,
    });
    expect(res.cleared).toBe(true);
  });
});

describe("autonomous hard gate — deferred-approval round trip", () => {
  it("an autonomous run stages a hold; a human then approves and executes it via the H2 path", async () => {
    // 1. Autonomous run prepares + stages the action (no token, no execution).
    const auto = makeAutonomousCtx();
    const staged = await preview(auto, externalWrite);
    expect(staged.outcome).toBe("staged_for_deferred_approval");
    expect(staged.confirm_token).toBeUndefined();

    // 2. A human, in an interactive session sharing the same store, approves it.
    //    approver_id must be a human and is recorded in the audit trail.
    const human: ToolContext = { ...auto, actor: { kind: "interactive", userId: "doug" } };
    const decision = (await approveAction(human, {
      approval_id: staged.approval_id,
      decision: "approve",
      approver_id: "doug@ourthinktank.com",
    })) as { status: string; confirm_token?: string };
    expect(decision.status).toBe("approved");
    expect(decision.confirm_token).toBeTruthy();

    // 3. The freshly-issued token clears under the interactive principal.
    const cleared = await execute(human, {
      confirm_token: decision.confirm_token,
      action: staged.resolved_action,
    });
    expect(cleared.cleared).toBe(true);
  });
});

describe("autonomous hard gate — reduced tool map", () => {
  it("the autonomous tool map withholds approve_action, set_policy, and pause_agents", () => {
    for (const t of ["approve_action", "set_policy", "pause_agents"]) {
      expect(Object.keys(governanceTools)).toContain(t);          // interactive has them
      expect(Object.keys(autonomousGovernanceTools)).not.toContain(t); // autonomous does not
    }
    // It keeps the read/queue tools the runner legitimately needs.
    expect(Object.keys(autonomousGovernanceTools)).toContain("preview_action");
    expect(Object.keys(autonomousGovernanceTools)).toContain("execute_action");
    expect(Object.keys(autonomousGovernanceTools)).toContain("list_pending_approvals");
  });

  it("registerGovernanceTools registers the reduced map for an autonomous principal", () => {
    const registered: string[] = [];
    const fakeServer = { registerTool: (name: string) => registered.push(name) } as never;
    registerGovernanceTools(fakeServer, makeAutonomousCtx());
    expect(registered).toContain("preview_action");
    expect(registered).toContain("execute_action");
    expect(registered).not.toContain("approve_action");
    expect(registered).not.toContain("set_policy");
    expect(registered).not.toContain("pause_agents");
  });
});

describe("deferred approval — edit-then-execute reviewer path", () => {
  const auditActions = async (ctx: ToolContext): Promise<string[]> => {
    const r = (await (ctx.db.from("audit_log").select("action") as unknown as Promise<{ data: Array<{ action: string }> }>));
    return (r.data ?? []).map((x) => x.action);
  };

  it("a human edits the staged payload, the server re-binds, and the edited action executes", async () => {
    const auto = makeAutonomousCtx();
    const staged = await preview(auto, externalWrite);
    expect(staged.outcome).toBe("staged_for_deferred_approval");

    const human: ToolContext = { ...auto, actor: { kind: "interactive", userId: "doug" } };
    const edited = {
      kind: "external", connector: "github", action: "create_issue",
      params: { title: "Bug (reworded by reviewer)" }, summary: "Open a reworded issue",
    };
    const decision = (await approveAction(human, {
      approval_id: staged.approval_id,
      decision: "approve",
      approver_id: "doug@ourthinktank.com",
      edited_action: edited,
    })) as { edited?: boolean; confirm_token?: string; resolved_action?: unknown };

    expect(decision.edited).toBe(true);
    expect(decision.confirm_token).toBeTruthy();
    expect(decision.resolved_action).toBeTruthy();

    // The edited action (echoed back) clears; the token is bound to it.
    const cleared = await execute(human, { confirm_token: decision.confirm_token, action: decision.resolved_action });
    expect(cleared.cleared).toBe(true);

    // approve / edit are both written to the audit trail.
    const actions = await auditActions(human);
    expect(actions).toContain("action_staged");
    expect(actions).toContain("action_edited");
    expect(actions).toContain("action_approved");
  });

  it("the token binds to the EDITED action: executing the original is refused (hash mismatch)", async () => {
    const auto = makeAutonomousCtx();
    const staged = await preview(auto, externalWrite);
    const human: ToolContext = { ...auto, actor: { kind: "interactive", userId: "doug" } };
    const decision = (await approveAction(human, {
      approval_id: staged.approval_id,
      decision: "approve",
      approver_id: "doug",
      edited_action: { kind: "external", connector: "github", action: "create_issue", params: { title: "Different" }, summary: "Different" },
    })) as { confirm_token?: string };
    // Echo the ORIGINAL staged action, not the edited one.
    await expect(
      execute(human, { confirm_token: decision.confirm_token, action: staged.resolved_action })
    ).rejects.toThrow(/match|hash/i);
  });

  it("re-classifies the edited payload: an edit that targets a private host is refused (SSRF)", async () => {
    const auto = makeAutonomousCtx();
    const staged = await preview(auto, externalWrite);
    const human: ToolContext = { ...auto, actor: { kind: "interactive", userId: "doug" } };
    await expect(
      approveAction(human, {
        approval_id: staged.approval_id,
        decision: "approve",
        approver_id: "doug",
        edited_action: { kind: "external", connector: "github", action: "create_issue", params: { url: "http://169.254.169.254/latest/meta-data" }, summary: "x" },
      })
    ).rejects.toThrow(/refused/i);
  });

  it("rejecting writes action_rejected and issues no token", async () => {
    const auto = makeAutonomousCtx();
    const staged = await preview(auto, externalWrite);
    const human: ToolContext = { ...auto, actor: { kind: "interactive", userId: "doug" } };
    const decision = (await approveAction(human, {
      approval_id: staged.approval_id, decision: "reject", approver_id: "doug",
    })) as { confirm_token?: string };
    expect(decision.confirm_token).toBeUndefined();
    expect(await auditActions(human)).toContain("action_rejected");
  });
});
