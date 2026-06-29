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
 * Soft-delete and disable every live trigger bound to (entityType,
 * entityId) for this company. Returns the number removed. Never throws.
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
    return (data ?? []).length;
  } catch (e) {
    console.error(`[triggers] cascade cleanup threw for ${entityType}:${entityId}:`, e);
    return 0;
  }
}
