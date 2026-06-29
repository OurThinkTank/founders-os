// ============================================================
// Founders OS — Trigger Cascade Cleanup
// ============================================================
// A trigger can be bound to an entity (a customer, a project, or the
// playbook run that installed it) via bound_entity_type / bound_entity_id.
// When that entity goes away, its watchers must go away too: a churned
// customer should not keep firing a dunning watcher, and a run-scoped
// trigger should not outlive its run.
//
// This is best-effort by design (it logs on failure rather than
// throwing) so a cascade problem never breaks the primary operation
// that triggered it (deleting a customer, completing a run). The caller
// gets the count it can surface; the soft-delete is reversible until
// the row is purged.
// ============================================================

import type { ToolContext } from "../../types/context.js";

/**
 * Dismiss any PENDING inbox rows belonging to these triggers. Called
 * whenever a trigger is soft-deleted - by delete_trigger or by the entity
 * cascade below. The trigger_fires FK is ON DELETE CASCADE, but that only
 * fires on a HARD delete; a soft-delete (deleted_at) leaves the trigger's
 * pending fires behind, so list_trigger_fires keeps surfacing fires for a
 * watch that no longer exists. Marking them dismissed (not hard-deleting)
 * keeps the row for history and is idempotent under the one-live-row-per-
 * trigger constraint. Best-effort: logs on failure, never throws, mirroring
 * the cascade contract so it can't break the primary delete. Returns the
 * number of fires dismissed.
 */
export async function dismissFiresForTriggers(
  ctx: ToolContext,
  triggerIds: string[]
): Promise<number> {
  if (triggerIds.length === 0) return 0;
  try {
    const { data, error } = await ctx.db
      .from("trigger_fires")
      .update({ status: "dismissed", acted_at: new Date().toISOString(), acted_by: "trigger-removed" })
      .eq("company_id", ctx.companyId)
      .in("trigger_id", triggerIds)
      .eq("status", "pending")
      .select("id");
    if (error) {
      console.error(`[triggers] failed to dismiss orphan fires: ${error.message}`);
      return 0;
    }
    return (data ?? []).length;
  } catch (e) {
    console.error(`[triggers] dismiss orphan fires threw:`, e);
    return 0;
  }
}

/**
 * Soft-delete and disable every live trigger bound to (entityType,
 * entityId) for this company. Also dismisses those triggers' pending inbox
 * fires so a churned watch leaves no orphan rows. Returns the number
 * removed. Never throws.
 */
export async function cascadeTriggersForEntity(
  ctx: ToolContext,
  entityType: string,
  entityId: string
): Promise<number> {
  try {
    const { data, error } = await ctx.db
      .from("triggers")
      .update({ deleted_at: new Date().toISOString(), enabled: false })
      .eq("company_id", ctx.companyId)
      .eq("bound_entity_type", entityType)
      .eq("bound_entity_id", entityId)
      .is("deleted_at", null)
      .select("id");
    if (error) {
      console.error(`[triggers] cascade cleanup failed for ${entityType}:${entityId}: ${error.message}`);
      return 0;
    }
    const ids = (data ?? []).map((r) => (r as { id: string }).id);
    await dismissFiresForTriggers(ctx, ids);
    return ids.length;
  } catch (e) {
    console.error(`[triggers] cascade cleanup threw for ${entityType}:${entityId}:`, e);
    return 0;
  }
}
