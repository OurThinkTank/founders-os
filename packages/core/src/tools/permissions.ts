// ============================================================
// Founders OS - Scope-Aware Permission Helpers
// ============================================================
// Centralizes permission checks for remove and restore
// operations. The rules:
//
//   Org-scoped items:  any member of the company can remove/restore
//   User-scoped items: only the creator (or system owner) can
//                      remove/restore
//
// "System owner" means the user has is_owner = true in
// company_members. Solo-mode users (ctx.isSoloMode === true) are
// always treated as owners.
//
// Usage:
//   import { canRemove } from "../permissions.js";
//   const perm = await canRemove(ctx, { scope, created_by, company_id });
//   if (!perm.allowed) throw new Error(perm.reason);
//
// ToolContext migration status (2026-05-28):
//   Contextual. ctx must be passed by callers; the lint
//   enforces no env-reading in this file.
// ============================================================

import type { ToolContext } from "../types/context.js";
import { isOwner } from "./financial/access.js";

export interface ScopedEntity {
  /** "personal" or "org". Org-scoped items are open to any company member. */
  scope: "personal" | "org";
  /** The user who created the item. Required for personal-scope checks. */
  created_by?: string;
  /** Alternative to created_by - some entities use user_id instead. */
  user_id?: string;
  /** The company this entity belongs to. */
  company_id: string;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether the calling user can remove (archive or delete) an entity.
 *
 * Rules:
 *   - Entity must belong to the caller's company
 *   - Org-scoped: any member can remove
 *   - Personal-scoped: only the creator or a system owner can remove
 */
export async function canRemove(
  ctx: ToolContext,
  entity: ScopedEntity
): Promise<PermissionResult> {
  // Must be in the same company
  if (entity.company_id !== ctx.companyId) {
    return {
      allowed: false,
      reason: "This item belongs to a different organization.",
    };
  }

  // Org-scoped: any company member can remove
  if (entity.scope === "org") {
    return { allowed: true };
  }

  // Personal-scoped: check ownership
  const owner = entity.created_by ?? entity.user_id;

  // If the caller is the creator, allow
  if (owner === ctx.userId) {
    return { allowed: true };
  }

  // If the caller is a system owner, allow
  if (await isOwner(ctx)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason:
      "This is a personal item. Only its creator or a system owner can remove or restore it.",
  };
}

/**
 * Check whether the calling user can restore an archived entity.
 * Uses the same rules as canRemove - if you could remove it,
 * you can restore it.
 */
export async function canRestore(
  ctx: ToolContext,
  entity: ScopedEntity
): Promise<PermissionResult> {
  return canRemove(ctx, entity);
}
