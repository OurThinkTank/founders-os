// ============================================================
// Founders OS — Financial Access Control Helpers
// ============================================================
// Shared utilities used by all financial tools and the
// financial management tools (set/get access, audit log).
//
// Access levels (financial_access_level enum):
//   none  — no financial tool access
//   read  — read-only tools (list, get, report)
//   write — full access; implicitly includes read
//
// Solo / env-var fallback:
//   When ctx.isSoloMode is true (single-user self-hosted install
//   where no real identity has been configured), or when no
//   company_members row exists for the caller, access falls back
//   to 'write' so existing single-user installs are completely
//   unaffected.
//
// ToolContext migration status (2026-05-28):
//   These helpers are fully contextual. Every public function
//   takes ToolContext as its first argument. The lint test
//   tool-context-lint.test.ts enforces no env-reading in this
//   file (see HELPER_FILES list).
// ============================================================

import type { ToolContext } from "../../types/context.js";

// Re-export from the shared audit module for backward compatibility.
// Tools that were already importing writeAuditLog from this file continue to work.
export { writeAuditLog, type AuditEntry } from "../audit.js";

export type FinancialAccessLevel = "none" | "read" | "write";

// ── Member lookup ────────────────────────────────────────────

interface MemberRecord {
  id: string;
  user_id: string;
  is_owner: boolean;
  financial_access: FinancialAccessLevel;
}

async function getMemberRecord(
  ctx: ToolContext,
  userId: string,
  companyId: string
): Promise<MemberRecord | null> {
  const { data, error } = await ctx.db
    .from("company_members")
    .select("id, user_id, is_owner, financial_access")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .single();

  if (error || !data) return null;
  return data as MemberRecord;
}

// ── Public helpers ────────────────────────────────────────────

/**
 * Returns the calling user's financial access level.
 * Falls back to 'write' for solo installs or when no member row exists.
 */
export async function getFinancialAccess(
  ctx: ToolContext
): Promise<FinancialAccessLevel> {
  if (ctx.isSoloMode) return "write";
  const member = await getMemberRecord(ctx, ctx.userId, ctx.companyId);
  if (!member) return "write"; // no row = solo/first-user, grant write
  return member.financial_access;
}

/**
 * Returns true if the calling user is an owner of their company.
 * Falls back to true for solo installs or when no member row exists.
 */
export async function isOwner(ctx: ToolContext): Promise<boolean> {
  if (ctx.isSoloMode) return true;
  const member = await getMemberRecord(ctx, ctx.userId, ctx.companyId);
  if (!member) return true; // no row = solo/first-user, treat as owner
  return member.is_owner;
}

/**
 * Returns true if the target user is the last remaining owner.
 * Used to prevent owners from revoking their own write access when
 * they are the sole owner (would lock the company out of financial tools).
 */
export async function isLastOwner(
  ctx: ToolContext,
  targetUserId: string
): Promise<boolean> {
  const { count } = await ctx.db
    .from("company_members")
    .select("id", { count: "exact", head: true })
    .eq("company_id", ctx.companyId)
    .eq("is_owner", true);
  return (count ?? 0) <= 1 && targetUserId === ctx.userId;
}

/**
 * Standardised permission error returned when access is denied.
 * Not a conflict — no retry path. The AI should relay this message.
 */
export function financialPermissionError(required: "read" | "write") {
  return {
    error: "permission_denied",
    message:
      required === "write"
        ? "You don't have permission to modify financial data. Ask an owner to grant you 'write' financial access."
        : "You don't have permission to view financial data. Ask an owner to grant you 'read' or 'write' financial access.",
    required_access: required,
  };
}

/**
 * Standardised error returned when a non-owner calls a management tool.
 */
export function ownerPermissionError() {
  return {
    error: "permission_denied",
    message: "Only company owners can manage financial access settings.",
    required_role: "owner",
  };
}
