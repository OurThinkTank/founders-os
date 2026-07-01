// ============================================================
// Founders OS — Audit actor stamping
// ============================================================
// writeAuditLog records actor_kind + run_id in metadata ONLY for the
// autonomous principal, so a surface like list_deleted can tell "the
// agent did this" apart from a human action. actor_id alone cannot:
// an autonomous run shares getUserId() with the interactive session on
// the same install. An absent/interactive actor leaves metadata as-is
// (the "absent actor is interactive" convention).
// ============================================================

import { describe, it, expect } from "vitest";
import { writeAuditLog } from "../tools/audit.js";
import type { ToolContext } from "../types/context.js";

function makeCtx(actor?: ToolContext["actor"]): { ctx: ToolContext; inserts: Record<string, unknown>[] } {
  const inserts: Record<string, unknown>[] = [];
  const admin = {
    from(_t: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
    },
  };
  const ctx = {
    db: admin,
    admin,
    companyId: "default",
    userId: "vince",
    identityMode: "env",
    isSoloMode: true,
    actor,
    embedding: { provider: "openai", model: "x", dimensions: 1, rateLimit: { maxCalls: 1, windowMs: 1 } },
  } as unknown as ToolContext;
  return { ctx, inserts };
}

const entry = { action: "delete_task", entity_type: "task", entity_id: "t1" };

describe("writeAuditLog — actor stamping", () => {
  it("interactive (absent actor): metadata stays null", async () => {
    const { ctx, inserts } = makeCtx(undefined);
    await writeAuditLog(ctx, entry);
    expect(inserts[0].metadata).toBeNull();
    expect(inserts[0].actor_id).toBe("vince");
  });

  it("interactive actor: does not stamp actor_kind, preserves caller metadata", async () => {
    const { ctx, inserts } = makeCtx({ kind: "interactive", userId: "vince" });
    await writeAuditLog(ctx, { ...entry, metadata: { foo: 1 } });
    expect(inserts[0].metadata).toEqual({ foo: 1 });
  });

  it("autonomous: stamps actor_kind + run_id", async () => {
    const { ctx, inserts } = makeCtx({ kind: "autonomous", runId: "run-9" });
    await writeAuditLog(ctx, entry);
    expect(inserts[0].metadata).toEqual({ actor_kind: "autonomous", run_id: "run-9" });
  });

  it("autonomous: merges actor fields onto caller metadata", async () => {
    const { ctx, inserts } = makeCtx({ kind: "autonomous", runId: "run-9" });
    await writeAuditLog(ctx, { ...entry, metadata: { brief: "overdue task" } });
    expect(inserts[0].metadata).toEqual({ brief: "overdue task", actor_kind: "autonomous", run_id: "run-9" });
  });
});
