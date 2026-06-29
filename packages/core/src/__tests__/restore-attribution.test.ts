// ============================================================
// Founders OS — list_deleted attribution helpers
// ============================================================
// indexLatestDeleteAudit + attributionFor fold the audit trail's
// delete_* entries onto trash rows so list_deleted can show who deleted
// each item (and filter to what the autonomous agent removed) without a
// per-table deleted_by column. Items with no audit entry are "unknown",
// never guessed.
// ============================================================

import { describe, it, expect } from "vitest";
import {
  indexLatestDeleteAudit,
  attributionFor,
  type AuditDeleteRow,
} from "../tools/restore.js";

describe("indexLatestDeleteAudit", () => {
  it("keeps the latest row per entity (caller passes created_at DESC)", () => {
    const rows: AuditDeleteRow[] = [
      { entity_id: "a", actor_id: "vince", metadata: null, created_at: "2026-06-29T10:00:00Z" },
      { entity_id: "a", actor_id: "vince", metadata: { actor_kind: "autonomous", run_id: "old" }, created_at: "2026-06-20T10:00:00Z" },
      { entity_id: "b", actor_id: "vince", metadata: { actor_kind: "autonomous", run_id: "r2" }, created_at: "2026-06-29T09:00:00Z" },
    ];
    const idx = indexLatestDeleteAudit(rows);
    expect(idx.size).toBe(2);
    // The newer 'a' row (no actor_kind) wins over the older autonomous one.
    expect(idx.get("a")?.created_at).toBe("2026-06-29T10:00:00Z");
  });
});

describe("attributionFor", () => {
  const idx = indexLatestDeleteAudit([
    { entity_id: "auto", actor_id: "vince", metadata: { actor_kind: "autonomous", run_id: "run-7" } },
    { entity_id: "human", actor_id: "vince", metadata: null },
    { entity_id: "human2", actor_id: "doug", metadata: { foo: 1 } },
  ]);

  it("autonomous entry -> autonomous + run_id", () => {
    expect(attributionFor("auto", idx)).toEqual({
      deleted_by_kind: "autonomous",
      deleted_by_actor: "vince",
      deleted_run_id: "run-7",
    });
  });

  it("entry without actor_kind -> interactive", () => {
    expect(attributionFor("human", idx)).toEqual({
      deleted_by_kind: "interactive",
      deleted_by_actor: "vince",
      deleted_run_id: null,
    });
    expect(attributionFor("human2", idx).deleted_by_kind).toBe("interactive");
  });

  it("no audit entry -> unknown, never guessed", () => {
    expect(attributionFor("missing", idx)).toEqual({
      deleted_by_kind: "unknown",
      deleted_by_actor: null,
      deleted_run_id: null,
    });
  });
});
