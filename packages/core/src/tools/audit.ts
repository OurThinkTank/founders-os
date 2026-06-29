// ============================================================
// Founders OS — Shared Audit Log Helper
// ============================================================
// writeAuditLog() is the single entry point for writing to the
// immutable audit_log table. It is non-throwing by design:
// audit failures are logged to stderr but never propagate to
// the caller — the primary operation must not fail because of
// an audit write error.
//
// Any tool in any domain can import this directly.
//
// ToolContext migration status (2026-05-28):
//   Contextual. Every caller must pass `ctx` so the company_id /
//   actor_id come from the call site's identity rather than the
//   global env. Audit writes use `ctx.admin` rather than `ctx.db`
//   because audit_log is an integrity-critical table that must be
//   writable even when the caller's `ctx.db` is a user-scoped
//   client (hosted mode); under self-hosted both clients point at
//   the same service-role client, so there is no behavior change.
// ============================================================

import type { ToolContext } from "../types/context.js";

export interface AuditEntry {
  action: string;
  entity_type: string;
  entity_id: string;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Writes an immutable entry to the audit_log table.
 * Failures are logged to stderr but do not throw — the primary
 * operation should not fail because of an audit write error.
 */
export async function writeAuditLog(
  ctx: ToolContext,
  entry: AuditEntry
): Promise<void> {
  try {
    // Use ctx.admin: audit_log writes must succeed even under hosted
    // mode where ctx.db may not have INSERT on audit_log via RLS.
    const { error } = await ctx.admin.from("audit_log").insert({
      company_id: ctx.companyId,
      actor_id: ctx.userId,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      before_state: entry.before_state ?? null,
      after_state: entry.after_state ?? null,
      metadata: entry.metadata ?? null,
    });
    if (error) {
      console.error(
        `[audit_log] Failed to write entry for action '${entry.action}': ${error.message}`
      );
    }
  } catch (e) {
    console.error(`[audit_log] Unexpected error writing entry:`, e);
  }
}

// ── Domain → action name sets (used by get_audit_log domain filter) ──────────

export const AUDIT_DOMAINS: Record<string, string[]> = {
  financial: [
    "add_transaction",
    "delete_transaction",
    "archive_transaction",
    "restore_financial_transaction",
    "transfer",
    "add_account",
    "delete_account",
    "archive_account",
    "restore_financial_account",
    "add_category",
    "delete_category",
    "archive_category",
    "restore_financial_category",
  ],
  crm: [
    "delete_customer",
    "archive_customer",
    "restore_customer",
    "delete_contact",
    "archive_contact",
    "restore_contact",
    "delete_interaction",
    "restore_interaction",
    "delete_tag",
    "archive_tag",
    "restore_tag",
  ],
  memory: ["memory_store", "memory_forget", "memory_update"],
  playbooks: [
    "run_playbook",
    "delete_playbook",
    "archive_playbook",
    "restore_playbook",
    "delete_playbook_step",
    "archive_playbook_step",
    "restore_playbook_step",
  ],
  tasks: [
    "delete_task",
    "archive_task",
    "restore_task",
  ],
  projects: [
    "delete_project",
    "archive_project",
    "restore_project",
  ],
  access: ["set_financial_access"],
  members: ["add_member", "set_member_owner", "remove_member"],
  governance: [
    "action_previewed",
    "action_held",
    "action_approved",
    "action_rejected",
    "action_executed",
    "guardrail_policy_updated",
    "reconcile_flagged",
  ],
  triggers: [
    "trigger_fired",
  ],
};
