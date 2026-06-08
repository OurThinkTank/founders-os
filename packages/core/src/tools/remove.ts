// ============================================================
// Founders OS - Shared Remove Handler
// ============================================================
// handleRemove() is the single entry point for all entity
// removal operations. It implements the standard flow:
//
//   1. Check permissions (canRemove)
//   2. If no mode specified, return a conflict with
//      ARCHIVE / DELETE / CANCEL options
//   3. If mode = "cancel", return early
//   4. If mode = "archive", call the entity's archiveFn
//   5. If mode = "delete", call the entity's deleteFn
//      (soft-delete: sets deleted_at, auto-purged after 30 days)
//   6. Write an audit log entry
//
// Each domain's remove_* tool becomes thin: fetch the entity,
// determine scope, and delegate to handleRemove with the right
// archiveFn and deleteFn.
//
// Usage:
//   import { handleRemove } from "../remove.js";
//
//   return handleRemove({
//     entity_type: "customer",
//     entity_id: customer.id,
//     entity_label: customer.organization_name,
//     scope: "org",
//     company_id: customer.company_id,
//     mode,
//     archiveFn: async () => { ... },
//     deleteFn: async () => { ... },
//   });
// ============================================================

import { z } from "zod";
import { conflict } from "./conflict.js";
import { canRemove, type ScopedEntity } from "./permissions.js";
import { writeAuditLog } from "./audit.js";
import type { ToolContext } from "../types/context.js";

export type RemoveMode = "archive" | "delete" | "cancel";

/**
 * Canonical destructive-action resolver value
 * (see docs/plan-resolution-param-standardization.md). Maps onto the
 * legacy archive/delete/cancel mode: "confirm" performs the delete.
 */
export type RemoveResolution = "confirm" | "archive" | "cancel";

const RESOLUTION_TO_MODE: Record<RemoveResolution, RemoveMode> = {
  confirm: "delete",
  archive: "archive",
  cancel: "cancel",
};

/**
 * Shared zod params for the destructive-action resolver. Spread into each
 * remove_* tool's parameter object so the resolver shape is identical
 * everywhere. Keeps the deprecated `mode` alias alongside `resolution`.
 */
export const removeResolutionParams = {
  resolution: z
    .enum(["confirm", "archive", "cancel"])
    .optional()
    .describe(
      "Resolution after the removal conflict: 'confirm' deletes (recoverable " +
      "for 30 days), 'archive' hides it (recoverable), 'cancel' aborts."
    ),
  mode: z
    .enum(["archive", "delete", "cancel"])
    .optional()
    .describe("Deprecated: use `resolution`. 'archive' / 'delete' / 'cancel'."),
};

export interface RemoveOptions {
  /**
   * Tool execution context. Threaded into permission checks (canRemove)
   * and through to access.ts helpers. Required as of 2026-05-28.
   */
  ctx: ToolContext;

  /** Entity type for audit logging (e.g. "customer", "task"). */
  entity_type: string;
  /** UUID of the entity being removed. */
  entity_id: string;
  /** Human-readable label for the conflict message (e.g. the entity name). */
  entity_label: string;

  /** Scope of the entity: "personal" or "org". */
  scope: "personal" | "org";
  /** Creator of the entity (for personal-scope permission checks). */
  created_by?: string;
  /** Alternative owner field (some entities use user_id). */
  user_id?: string;
  /** Company the entity belongs to. */
  company_id: string;

  /**
   * The user's chosen resolution. Takes precedence over `mode`. Undefined on
   * the first call (triggers the conflict).
   */
  resolution?: RemoveResolution;

  /** Deprecated legacy alias for `resolution`. */
  mode?: RemoveMode;

  /**
   * Summary of linked/dependent data shown in the conflict message.
   * e.g. { contacts: 3, open_tasks: 2 }
   * Keys become human-readable labels, values are counts.
   */
  linked_data?: Record<string, number>;

  /**
   * Additional warning text appended to the conflict message
   * for the DELETE option. Use for cascading consequences.
   * e.g. "All 3 contacts and their interaction history will be permanently deleted."
   */
  delete_warning?: string;

  /** Sets the archived flag/status. Called when mode = "archive". */
  archiveFn: () => Promise<unknown>;
  /** Soft-deletes the entity (sets deleted_at). Called when mode = "delete". */
  deleteFn: () => Promise<unknown>;

  /**
   * Snapshot of entity state before removal, written to the audit log.
   * If not provided, audit log will have null before_state.
   */
  before_state?: Record<string, unknown>;
}

/**
 * Shared remove handler. Returns a conflict response on first call,
 * executes the chosen action on retry.
 */
export async function handleRemove(opts: RemoveOptions): Promise<unknown> {
  // Normalize the canonical `resolution` onto the legacy mode. `resolution`
  // wins when both are present.
  const mode: RemoveMode | undefined = opts.resolution
    ? RESOLUTION_TO_MODE[opts.resolution]
    : opts.mode;

  // ── 1. Permission check ──────────────────────────────────
  const scopedEntity: ScopedEntity = {
    scope: opts.scope,
    created_by: opts.created_by,
    user_id: opts.user_id,
    company_id: opts.company_id,
  };

  const perm = await canRemove(opts.ctx, scopedEntity);
  if (!perm.allowed) {
    return {
      error: "permission_denied",
      message: perm.reason,
    };
  }

  // ── 2. No mode yet - return conflict ─────────────────────
  if (!mode) {
    const linkedParts = opts.linked_data
      ? Object.entries(opts.linked_data)
          .filter(([, count]) => count > 0)
          .map(([label, count]) => `${count} ${label}`)
      : [];

    const linkedSuffix = linkedParts.length > 0
      ? ` It has ${linkedParts.join(", ")}.`
      : "";

    const deleteLabel = opts.delete_warning
      ? `Delete - Remove (recoverable for 30 days, then permanently purged). ${opts.delete_warning}`
      : "Delete - Remove (recoverable for 30 days, then permanently purged)";

    return conflict(
      "destructive_action",
      `You are about to remove "${opts.entity_label}".${linkedSuffix} Choose an action:`,
      [
        {
          key: "archive",
          label: "Archive - Hide from active views, can be restored later",
          value: { resolution: "archive" },
        },
        {
          key: "delete",
          label: deleteLabel,
          value: { resolution: "confirm" },
        },
        {
          key: "cancel",
          label: "Cancel - Do nothing",
          value: { resolution: "cancel" },
        },
      ],
      {
        entity_type: opts.entity_type,
        entity_id: opts.entity_id,
        ...(opts.linked_data ? { linked_data: opts.linked_data } : {}),
      }
    );
  }

  // ── 3. Cancel ────────────────────────────────────────────
  if (mode === "cancel") {
    return {
      success: false,
      message: "Operation cancelled. No changes were made.",
    };
  }

  // ── 4. Archive ───────────────────────────────────────────
  if (mode === "archive") {
    const result = await opts.archiveFn();

    await writeAuditLog(opts.ctx, {
      action: `archive_${opts.entity_type}`,
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      before_state: opts.before_state ?? null,
      after_state: { archived: true },
    });

    return {
      success: true,
      action: "archived",
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      entity_label: opts.entity_label,
      message: `"${opts.entity_label}" has been archived. It is hidden from active views and can be brought back any time.`,
      ...(result && typeof result === "object" ? { data: result } : {}),
    };
  }

  // ── 5. Soft-delete ────────────────────────────────────────
  if (mode === "delete") {
    const result = await opts.deleteFn();
    const deletedAt = new Date();
    // The auto-purge runs 30 days after deleted_at. Compute the calendar
    // date the user can rely on as a recovery window cutoff.
    const recoverableUntil = new Date(
      deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000
    );
    const recoverable_until = recoverableUntil.toISOString().slice(0, 10);

    await writeAuditLog(opts.ctx, {
      action: `delete_${opts.entity_type}`,
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      before_state: opts.before_state ?? null,
      after_state: { deleted_at: deletedAt.toISOString() },
    });

    return {
      success: true,
      action: "deleted",
      entity_type: opts.entity_type,
      entity_id: opts.entity_id,
      entity_label: opts.entity_label,
      recoverable_until,
      message: `"${opts.entity_label}" has been deleted. Recoverable until ${recoverable_until} if you change your mind.`,
      ...(result && typeof result === "object" ? { data: result } : {}),
    };
  }

  // Should not reach here - invalid mode
  throw new Error(`Invalid remove mode: "${mode}". Expected "archive", "delete", or "cancel".`);
}
