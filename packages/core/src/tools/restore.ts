// ============================================================
// Founders OS - Universal Restore Tool
// ============================================================
// A single restore_item tool that can restore any archived or
// soft-deleted entity. It looks up the entity by type + id,
// verifies it is archived or deleted, checks permissions via
// canRestore, then clears the archive flag and/or deleted_at.
//
// Supported entity types:
//   customer, contact, task, tag, playbook, playbook_step,
//   project, financial_account, financial_category,
//   financial_transaction
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "./register.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canRestore } from "./permissions.js";
import { writeAuditLog } from "./audit.js";
import type { ToolContext } from "../types/context.js";
import { conflict } from "./conflict.js";
import type { Render } from "../types/render.js";

const ENTITY_TYPES = [
  "customer",
  "contact",
  "interaction",
  "task",
  "tag",
  "playbook",
  "playbook_step",
  "project",
  "financial_account",
  "financial_category",
  "financial_transaction",
] as const;

type RestorableEntity = (typeof ENTITY_TYPES)[number];

/** Table name and archive column/value for each entity type. */
interface RestoreConfig {
  table: string;
  /** Column that indicates archived state. */
  archiveColumn: string;
  /** The "archived" value. */
  archivedValue: unknown;
  /** The "active" value to restore to. */
  activeValue: unknown;
  /** Column to check for label in the response. */
  labelColumn: string;
  /** How to determine scope. "org" = always org-scoped. "check" = read from entity. */
  scope: "org" | "check";
  /** For scope="check", the column that holds scope value. */
  scopeColumn?: string;
  /** For scope="check", the column that holds creator. */
  createdByColumn?: string;
  /** Column that holds company_id. */
  companyColumn: string;
  /** True for entities that only soft-delete (no archive state), e.g. interactions. */
  softDeleteOnly?: boolean;
}

const RESTORE_CONFIG: Record<RestorableEntity, RestoreConfig> = {
  customer: {
    table: "customers",
    archiveColumn: "customer_phase",
    archivedValue: "inactive",
    activeValue: "lead",
    labelColumn: "organization_name",
    scope: "org",
    companyColumn: "company_id",
  },
  contact: {
    table: "contacts",
    archiveColumn: "is_active",
    archivedValue: false,
    activeValue: true,
    labelColumn: "first_name",
    scope: "org",
    companyColumn: "customer_id", // needs join - handled specially
  },
  interaction: {
    table: "interactions",
    archiveColumn: "deleted_at", // soft-delete only; no archive state
    archivedValue: "__never__",
    activeValue: null,
    labelColumn: "subject",
    scope: "org",
    companyColumn: "customer_id", // needs join - handled specially
    softDeleteOnly: true,
  },
  task: {
    table: "tasks",
    archiveColumn: "archived_at",
    archivedValue: "__notnull__", // special: archived_at IS NOT NULL means archived
    activeValue: null,
    labelColumn: "title",
    scope: "check",
    scopeColumn: "scope",
    createdByColumn: "created_by",
    companyColumn: "company_id",
  },
  tag: {
    table: "tag_registry",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "name",
    scope: "org",
    companyColumn: "company_id",
  },
  playbook: {
    table: "playbooks",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "name",
    scope: "org",
    companyColumn: "company_id",
  },
  playbook_step: {
    table: "playbook_steps",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "title",
    scope: "org",
    companyColumn: "playbook_id", // needs join - handled specially
  },
  project: {
    table: "projects",
    archiveColumn: "status",
    archivedValue: "archived",
    activeValue: "active",
    labelColumn: "name",
    scope: "org",
    companyColumn: "company_id",
  },
  financial_account: {
    table: "financial_accounts",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "name",
    scope: "org",
    companyColumn: "company_id",
  },
  financial_category: {
    table: "financial_categories",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "name",
    scope: "org",
    companyColumn: "company_id",
  },
  financial_transaction: {
    table: "financial_transactions",
    archiveColumn: "archived",
    archivedValue: true,
    activeValue: false,
    labelColumn: "description",
    scope: "org",
    companyColumn: "company_id",
  },
};

// ── Trash helpers (list_deleted / purge_item) ─────────────────

/** Entity types that carry a `tags` text[] column (used for demo detection). */
const TYPES_WITH_TAGS = new Set<RestorableEntity>([
  "customer",
  "task",
  "financial_account",
  "financial_category",
  "financial_transaction",
]);

/** Columns to select per type for the deleted-items listing. */
function deletedSelect(type: RestorableEntity): string {
  if (type === "contact")
    return "id, deleted_at, first_name, last_name, customers!inner(company_id, organization_name)";
  if (type === "interaction")
    return "id, deleted_at, subject, customers!inner(company_id, organization_name)";
  if (type === "playbook_step")
    return "id, deleted_at, title, playbooks!inner(company_id)";
  const cols = ["id", "deleted_at", RESTORE_CONFIG[type].labelColumn];
  if (TYPES_WITH_TAGS.has(type)) cols.push("tags");
  return cols.join(", ");
}

interface DeletedItem {
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
  deleted_at: string;
  tags?: string[];
  parent_name?: string;
}

// ── Deletion attribution (who soft-deleted each trash item) ───
// Sourced from audit_log, not a per-table deleted_by column: every
// soft-delete writes a `delete_<type>` audit entry, and writeAuditLog
// stamps actor_kind=autonomous (+ run_id) for the unattended agent. So
// the trail already says who deleted what; here we fold it onto the trash
// rows. Items with no matching audit entry (e.g. a cascade soft-delete
// that did not audit per row) are reported as "unknown" rather than
// guessed.

export type DeletedByKind = "autonomous" | "interactive" | "unknown";

export interface DeletionAttribution {
  deleted_by_kind: DeletedByKind;
  deleted_by_actor: string | null;
  deleted_run_id: string | null;
}

export interface AuditDeleteRow {
  entity_id: string;
  actor_id?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
}

/**
 * Index audit delete-rows by entity_id, keeping the latest per entity.
 * Caller passes rows ordered created_at DESC, so the first seen wins.
 */
export function indexLatestDeleteAudit(rows: AuditDeleteRow[]): Map<string, AuditDeleteRow> {
  const idx = new Map<string, AuditDeleteRow>();
  for (const r of rows) {
    if (r.entity_id && !idx.has(r.entity_id)) idx.set(r.entity_id, r);
  }
  return idx;
}

/** Resolve a single item's attribution from the audit index. */
export function attributionFor(
  entityId: string,
  idx: Map<string, AuditDeleteRow>
): DeletionAttribution {
  const a = idx.get(entityId);
  if (!a) return { deleted_by_kind: "unknown", deleted_by_actor: null, deleted_run_id: null };
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const kind: DeletedByKind = meta.actor_kind === "autonomous" ? "autonomous" : "interactive";
  return {
    deleted_by_kind: kind,
    deleted_by_actor: a.actor_id ?? null,
    deleted_run_id: typeof meta.run_id === "string" ? meta.run_id : null,
  };
}

function toDeletedItem(type: RestorableEntity, row: Record<string, unknown>): DeletedItem {
  const id = row.id as string;
  let label: string;
  let parent_name: string | undefined;
  if (type === "contact") {
    label = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || id;
    parent_name = (row.customers as { organization_name?: string } | null)?.organization_name;
  } else if (type === "interaction") {
    label = (row.subject as string) ?? id;
    parent_name = (row.customers as { organization_name?: string } | null)?.organization_name;
  } else {
    label = (row[RESTORE_CONFIG[type].labelColumn] as string) ?? id;
  }
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : undefined;
  return { entity_type: type, entity_id: id, label, deleted_at: row.deleted_at as string, tags, parent_name };
}

/**
 * Best-effort detection of leftover demo / test fixtures so they can be hidden
 * by default. Covers the conventions demos have used: the demorun- run tag, the
 * "(demo <runid>)" name suffix, and the older "Demo: " / "Demo " name prefix and
 * demo- / __marker__ tags.
 */
function isDemoFixture(item: DeletedItem): boolean {
  const looksDemo = (s: string | undefined): boolean =>
    !!s && (/\(demo[\s)]/i.test(s) || /^demo[:\s-]/i.test(s));
  if (looksDemo(item.label) || looksDemo(item.parent_name)) return true;
  if (
    item.entity_type === "tag" &&
    (/^demorun-/.test(item.label) || /^demo-/.test(item.label) || /^__.*__$/.test(item.label))
  ) {
    return true;
  }
  if (
    item.tags?.some(
      (t) => typeof t === "string" && (/^demorun-/.test(t) || /^demo-/.test(t))
    )
  ) {
    return true;
  }
  return false;
}

/** Resolve the owning company_id for an entity, joining through the parent where needed. */
async function resolveEntityCompany(
  supabase: SupabaseClient,
  type: RestorableEntity,
  entity: Record<string, unknown>
): Promise<string> {
  if (type === "contact" || type === "interaction") {
    const { data } = await supabase
      .from("customers")
      .select("company_id")
      .eq("id", entity.customer_id as string)
      .single();
    return (data as { company_id: string } | null)?.company_id ?? "";
  }
  if (type === "playbook_step") {
    const { data } = await supabase
      .from("playbooks")
      .select("company_id")
      .eq("id", entity.playbook_id as string)
      .single();
    return (data as { company_id: string } | null)?.company_id ?? "";
  }
  return entity[RESTORE_CONFIG[type].companyColumn] as string;
}

// ── Shared action core (used by single + batch restore/purge) ─

/** Human label for an entity row. */
function entityLabel(type: RestorableEntity, entity: Record<string, unknown>, fallback: string): string {
  if (type === "contact") {
    return `${entity.first_name ?? ""} ${entity.last_name ?? ""}`.trim() || fallback;
  }
  return (entity[RESTORE_CONFIG[type].labelColumn] as string) ?? fallback;
}

type ActionLoad =
  | { ok: true; entity: Record<string, unknown>; entityCompanyId: string; label: string }
  | { ok: false; status: "not_found" | "permission_denied"; message: string; label: string };

/** Fetch an entity (including soft-deleted/archived rows) and verify company ownership. */
async function loadEntityForAction(
  supabase: SupabaseClient,
  companyId: string,
  type: RestorableEntity,
  id: string
): Promise<ActionLoad> {
  const config = RESTORE_CONFIG[type];
  const { data, error } = await supabase.from(config.table).select("*").eq("id", id).single();
  if (error || !data) {
    return { ok: false, status: "not_found", message: `${type.replace(/_/g, " ")} not found`, label: id };
  }
  const entity = data as Record<string, unknown>;
  const label = entityLabel(type, entity, id);
  const entityCompanyId = await resolveEntityCompany(supabase, type, entity);
  if (entityCompanyId !== companyId) {
    return { ok: false, status: "permission_denied", message: "This item belongs to a different organization.", label };
  }
  return { ok: true, entity, entityCompanyId, label };
}

async function checkActionPermission(
  ctx: ToolContext,
  config: RestoreConfig,
  entity: Record<string, unknown>,
  entityCompanyId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const scope =
    config.scope === "check" && config.scopeColumn
      ? (entity[config.scopeColumn] as "personal" | "org")
      : "org";
  return canRestore(ctx, {
    scope,
    created_by: config.createdByColumn ? (entity[config.createdByColumn] as string | undefined) : undefined,
    company_id: entityCompanyId,
  });
}

interface RestoreOutcome {
  status: "restored" | "not_applicable" | "permission_denied" | "not_found";
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
  restored_from?: "deleted" | "archived";
  message?: string;
}

/** Restore one archived/soft-deleted entity. Reusable across the single + batch tools. */
async function restoreOne(
  ctx: ToolContext,
  supabase: SupabaseClient,
  companyId: string,
  entity_type: RestorableEntity,
  entity_id: string
): Promise<RestoreOutcome> {
  const config = RESTORE_CONFIG[entity_type];
  const loaded = await loadEntityForAction(supabase, companyId, entity_type, entity_id);
  if (!loaded.ok) {
    return { status: loaded.status, entity_type, entity_id, label: loaded.label, message: loaded.message };
  }
  const { entity, entityCompanyId, label } = loaded;

  const isArchived = config.softDeleteOnly
    ? false
    : config.archivedValue === "__notnull__"
      ? entity[config.archiveColumn] != null
      : entity[config.archiveColumn] === config.archivedValue;
  const isSoftDeleted = entity.deleted_at != null;

  if (!isArchived && !isSoftDeleted) {
    return {
      status: "not_applicable",
      entity_type,
      entity_id,
      label,
      message: `This ${entity_type.replace(/_/g, " ")} is not archived or deleted.`,
    };
  }

  const perm = await checkActionPermission(ctx, config, entity, entityCompanyId);
  if (!perm.allowed) {
    return { status: "permission_denied", entity_type, entity_id, label, message: perm.reason };
  }

  const updates: Record<string, unknown> = {};
  const beforeState: Record<string, unknown> = {};
  const afterState: Record<string, unknown> = {};

  if (isArchived) {
    updates[config.archiveColumn] = config.activeValue;
    beforeState[config.archiveColumn] = entity[config.archiveColumn];
    afterState[config.archiveColumn] = config.activeValue;
  }

  if (isSoftDeleted) {
    updates.deleted_at = null;
    beforeState.deleted_at = entity.deleted_at;
    afterState.deleted_at = null;

    if (entity_type === "financial_transaction" && entity.amount != null && entity.account_id) {
      const { error: balErr } = await supabase.rpc("restore_financial_transaction_balance", {
        p_account_id: entity.account_id,
        p_amount: entity.amount,
      });
      if (balErr) console.error(`Balance restore warning: ${balErr.message}`);
    }
    if (entity_type === "playbook") {
      await supabase
        .from("playbook_steps")
        .update({ deleted_at: null })
        .eq("playbook_id", entity_id)
        .not("deleted_at", "is", null);
    }
    if (entity_type === "project" && entity.slug) {
      await supabase
        .from("tag_registry")
        .update({ deleted_at: null })
        .eq("company_id", companyId)
        .eq("slug", entity.slug as string)
        .not("deleted_at", "is", null);
    }
  }

  const { error: updateErr } = await supabase.from(config.table).update(updates).eq("id", entity_id);
  if (updateErr) {
    throw new Error(`Failed to restore ${entity_type}: ${updateErr.message}`);
  }

  await writeAuditLog(ctx, {
    action: `restore_${entity_type}`,
    entity_type,
    entity_id,
    before_state: beforeState,
    after_state: afterState,
  });

  return { status: "restored", entity_type, entity_id, label, restored_from: isSoftDeleted ? "deleted" : "archived" };
}

interface PurgeOutcome {
  status: "purged" | "not_in_trash" | "permission_denied" | "not_found" | "blocked";
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
  message?: string;
}

/** Permanently delete one soft-deleted entity. Reusable across the single + batch tools. */
async function purgeOne(
  ctx: ToolContext,
  supabase: SupabaseClient,
  companyId: string,
  entity_type: RestorableEntity,
  entity_id: string
): Promise<PurgeOutcome> {
  const config = RESTORE_CONFIG[entity_type];
  const loaded = await loadEntityForAction(supabase, companyId, entity_type, entity_id);
  if (!loaded.ok) {
    return { status: loaded.status, entity_type, entity_id, label: loaded.label, message: loaded.message };
  }
  const { entity, entityCompanyId, label } = loaded;

  if (entity.deleted_at == null) {
    return {
      status: "not_in_trash",
      entity_type,
      entity_id,
      label,
      message: `This ${entity_type.replace(/_/g, " ")} is not in the trash - only soft-deleted items can be purged.`,
    };
  }

  const perm = await checkActionPermission(ctx, config, entity, entityCompanyId);
  if (!perm.allowed) {
    return { status: "permission_denied", entity_type, entity_id, label, message: perm.reason };
  }

  const { error: delErr } = await supabase
    .from(config.table)
    .delete()
    .eq("id", entity_id)
    .not("deleted_at", "is", null);
  if (delErr) {
    return {
      status: "blocked",
      entity_type,
      entity_id,
      label,
      message: `${delErr.message} - it may still be referenced by other records (e.g. transactions).`,
    };
  }

  await writeAuditLog(ctx, {
    action: `purge_${entity_type}`,
    entity_type,
    entity_id,
    before_state: { label, deleted_at: entity.deleted_at },
    after_state: null,
  });

  return { status: "purged", entity_type, entity_id, label };
}

/** Gather soft-deleted items (the trash) for the company, with demo filtering. */
async function gatherDeleted(
  supabase: SupabaseClient,
  companyId: string,
  opts: { days: number; entity_type?: RestorableEntity; includeDemo: boolean; onlyDemo?: boolean }
): Promise<DeletedItem[]> {
  const cutoff = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  const types = opts.entity_type ? [opts.entity_type] : ENTITY_TYPES;
  const perType = await Promise.all(
    types.map(async (type) => {
      let q = supabase
        .from(RESTORE_CONFIG[type].table)
        .select(deletedSelect(type))
        .not("deleted_at", "is", null)
        .gte("deleted_at", cutoff);
      if (type === "contact" || type === "interaction") {
        q = q.eq("customers.company_id", companyId);
      } else if (type === "playbook_step") {
        q = q.eq("playbooks.company_id", companyId);
      } else {
        q = q.eq("company_id", companyId);
      }
      const { data, error } = await q.order("deleted_at", { ascending: false }).limit(500);
      if (error) return [] as DeletedItem[];
      return (data ?? []).map((r) => toDeletedItem(type, r as unknown as Record<string, unknown>));
    })
  );
  let all = perType.flat();
  if (opts.onlyDemo) all = all.filter((i) => isDemoFixture(i));
  else if (!opts.includeDemo) all = all.filter((i) => !isDemoFixture(i));
  all.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : a.deleted_at > b.deleted_at ? -1 : 0));
  return all;
}

interface BatchTarget {
  entity_type: RestorableEntity;
  entity_id: string;
  label: string;
}

interface BatchSelect {
  items?: { entity_type: RestorableEntity; entity_id: string }[];
  entity_type?: RestorableEntity;
  older_than_days?: number;
  only_demo?: boolean;
  all?: boolean;
  days?: number;
}

/** True when at least one filter (not an explicit item list) is set. */
function hasBatchFilter(p: BatchSelect): boolean {
  return Boolean(p.all || p.only_demo || p.entity_type || p.older_than_days != null);
}

/** Resolve a batch selection (explicit items or filters) into concrete targets with labels. */
async function resolveBatchTargets(
  supabase: SupabaseClient,
  companyId: string,
  p: BatchSelect
): Promise<BatchTarget[]> {
  if (p.items && p.items.length > 0) {
    const out: BatchTarget[] = [];
    for (const it of p.items) {
      const loaded = await loadEntityForAction(supabase, companyId, it.entity_type, it.entity_id);
      if (loaded.ok) out.push({ entity_type: it.entity_type, entity_id: it.entity_id, label: loaded.label });
    }
    return out;
  }
  const days = p.days ?? 30;
  let items = await gatherDeleted(supabase, companyId, {
    days,
    entity_type: p.entity_type,
    includeDemo: Boolean(p.all),
    onlyDemo: p.only_demo,
  });
  if (p.older_than_days != null) {
    const cut = Date.now() - p.older_than_days * 86_400_000;
    items = items.filter((i) => new Date(i.deleted_at).getTime() < cut);
  }
  return items.map((i) => ({ entity_type: i.entity_type, entity_id: i.entity_id, label: i.label }));
}

/** Purge order: children before parents so cascades don't turn siblings into not_found. */
const PURGE_RANK: Record<RestorableEntity, number> = {
  interaction: 0,
  contact: 1,
  playbook_step: 2,
  task: 3,
  tag: 3,
  financial_transaction: 3,
  financial_category: 4,
  financial_account: 4,
  project: 5,
  playbook: 6,
  customer: 7,
};

/** Count targets by entity_type for confirmation summaries. */
function countByType(targets: BatchTarget[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of targets) {
    const k = t.entity_type.replace(/_/g, " ");
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export const restoreTools: ToolMap = {
  restore_item: {
    title: "Restore Archived or Deleted Item",
    description:
      "Restore a previously archived or soft-deleted item back to active state. Works for any entity type " +
      "that supports archiving or deletion: customer, contact, task, tag, playbook, playbook_step, " +
      "project, financial_account, financial_category, financial_transaction. " +
      "Soft-deleted items are automatically purged after 30 days - restore before then to recover. " +
      "Permission rules: org-scoped items can be restored by any company member; " +
      "personal-scoped items (tasks) can only be restored by the creator or system owner.",
    parameters: z.object({
      entity_type: z
        .enum(ENTITY_TYPES)
        .describe("Type of entity to restore."),
      entity_id: z
        .string()
        .uuid()
        .describe("UUID of the archived or soft-deleted entity."),
    }),
    handler: async (ctx: ToolContext, {
      entity_type,
      entity_id,
    }: {
      entity_type: RestorableEntity;
      entity_id: string;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const config = RESTORE_CONFIG[entity_type];

      // ── Fetch the entity ──────────────────────────────────
      const { data: entity, error: fetchErr } = await supabase
        .from(config.table)
        .select("*")
        .eq("id", entity_id)
        .single();

      if (fetchErr || !entity) {
        throw new Error(`${entity_type} not found: ${fetchErr?.message ?? "no match"}`);
      }

      // ── Verify company access ─────────────────────────────
      let entityCompanyId: string;

      if (entity_type === "contact" || entity_type === "interaction") {
        const { data: cust } = await supabase
          .from("customers")
          .select("company_id")
          .eq("id", entity.customer_id)
          .single();
        entityCompanyId = (cust as { company_id: string })?.company_id ?? "";
      } else if (entity_type === "playbook_step") {
        const { data: pb } = await supabase
          .from("playbooks")
          .select("company_id")
          .eq("id", entity.playbook_id)
          .single();
        entityCompanyId = (pb as { company_id: string })?.company_id ?? "";
      } else {
        entityCompanyId = entity[config.companyColumn] as string;
      }

      if (entityCompanyId !== companyId) {
        return {
          error: "permission_denied",
          message: "This item belongs to a different organization.",
        };
      }

      // ── Determine what state the entity is in ─────────────
      const isArchived = config.softDeleteOnly
        ? false
        : config.archivedValue === "__notnull__"
          ? entity[config.archiveColumn] != null
          : entity[config.archiveColumn] === config.archivedValue;

      const isSoftDeleted = entity.deleted_at != null;

      if (!isArchived && !isSoftDeleted) {
        return {
          success: false,
          message: `This ${entity_type.replace(/_/g, " ")} is not archived or deleted.`,
        };
      }

      // ── Permission check ──────────────────────────────────
      const scope =
        config.scope === "check" && config.scopeColumn
          ? (entity[config.scopeColumn] as "personal" | "org")
          : "org";

      const perm = await canRestore(ctx, {
        scope,
        created_by: config.createdByColumn
          ? (entity[config.createdByColumn] as string | undefined)
          : undefined,
        company_id: entityCompanyId,
      });

      if (!perm.allowed) {
        return { error: "permission_denied", message: perm.reason };
      }

      // ── Build the restore update ──────────────────────────
      const updates: Record<string, unknown> = {};
      const beforeState: Record<string, unknown> = {};
      const afterState: Record<string, unknown> = {};

      if (isArchived) {
        updates[config.archiveColumn] = config.activeValue;
        beforeState[config.archiveColumn] = entity[config.archiveColumn];
        afterState[config.archiveColumn] = config.activeValue;
      }

      if (isSoftDeleted) {
        updates.deleted_at = null;
        beforeState.deleted_at = entity.deleted_at;
        afterState.deleted_at = null;

        // For financial transactions, re-apply the balance when restoring
        // from soft-delete (balance was reversed at delete time).
        if (entity_type === "financial_transaction" && entity.amount != null && entity.account_id) {
          const { error: balErr } = await supabase.rpc("restore_financial_transaction_balance", {
            p_account_id: entity.account_id,
            p_amount: entity.amount,
          });
          if (balErr) {
            // Non-fatal: log but continue - balance can be manually corrected
            console.error(`Balance restore warning: ${balErr.message}`);
          }
        }

        // For playbooks, also restore soft-deleted steps
        if (entity_type === "playbook") {
          await supabase
            .from("playbook_steps")
            .update({ deleted_at: null })
            .eq("playbook_id", entity_id)
            .not("deleted_at", "is", null);
        }

        // For projects, also restore the soft-deleted tag
        if (entity_type === "project" && entity.slug) {
          await supabase
            .from("tag_registry")
            .update({ deleted_at: null })
            .eq("company_id", companyId)
            .eq("slug", entity.slug)
            .not("deleted_at", "is", null);
        }
      }

      const { data: restored, error: updateErr } = await supabase
        .from(config.table)
        .update(updates)
        .eq("id", entity_id)
        .select()
        .single();

      if (updateErr) {
        throw new Error(`Failed to restore ${entity_type}: ${updateErr.message}`);
      }

      // ── Audit log ─────────────────────────────────────────
      await writeAuditLog(ctx, {
        action: `restore_${entity_type}`,
        entity_type,
        entity_id,
        before_state: beforeState,
        after_state: afterState,
      });

      const label =
        entity_type === "contact"
          ? `${entity.first_name} ${entity.last_name}`
          : (entity[config.labelColumn] as string) ?? entity_id;

      const restoredFrom = isSoftDeleted ? "deleted" : "archived";

      return {
        success: true,
        action: "restored",
        entity_type,
        entity_id,
        entity_label: label,
        restored_from: restoredFrom,
        message: `"${label}" has been restored from ${restoredFrom} state.`,
        data: restored,
      };
    },
  },
  list_deleted: {
    title: "List Deleted Items",
    description:
      "List recently soft-deleted items (the recoverable trash) for the current company so the user can pick one to restore or permanently delete. Returns each item's type, a human-readable label, who deleted it (deleted_by_kind: 'autonomous' = the unattended agent, 'interactive' = a person, 'unknown' = no audit record), when it was deleted, and the date it will be auto-purged. Defaults to the last 7 days with leftover demo fixtures hidden; pass days to widen the window, entity_type to filter, include_demo to show demo data, or deleted_by_kind: 'autonomous' to answer \"what did the agent delete?\". Each item carries entity_id for use with restore_item or purge_item - present items to the user by label, never by id. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      days: z
        .number()
        .optional()
        .describe("Look-back window in days. Defaults to 7."),
      entity_type: z
        .enum(ENTITY_TYPES)
        .optional()
        .describe("Filter to a single entity type. Omit for all types."),
      include_demo: z
        .boolean()
        .optional()
        .describe("Include leftover demo (demorun-) fixtures. Defaults to false."),
      deleted_by_kind: z
        .enum(["autonomous", "interactive"])
        .optional()
        .describe(
          "Filter by who deleted the item: 'autonomous' = the unattended agent (use this for \"what did the agent delete?\"), 'interactive' = a human session. Omit for all. Items whose deleter is unknown (e.g. cascade deletes) are excluded when this filter is set."
        ),
      limit: z
        .number()
        .optional()
        .describe("Max items to return. Defaults to 100."),
    }),
    handler: async (ctx: ToolContext, {
      days = 7,
      entity_type,
      include_demo = false,
      deleted_by_kind,
      limit = 100,
    }: {
      days?: number;
      entity_type?: RestorableEntity;
      include_demo?: boolean;
      deleted_by_kind?: "autonomous" | "interactive";
      limit?: number;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const types = entity_type ? [entity_type] : ENTITY_TYPES;

      const perType = await Promise.all(
        types.map(async (type) => {
          let q = supabase
            .from(RESTORE_CONFIG[type].table)
            .select(deletedSelect(type))
            .not("deleted_at", "is", null)
            .gte("deleted_at", cutoff);
          if (type === "contact" || type === "interaction") {
            q = q.eq("customers.company_id", companyId);
          } else if (type === "playbook_step") {
            q = q.eq("playbooks.company_id", companyId);
          } else {
            q = q.eq("company_id", companyId);
          }
          const { data, error } = await q
            .order("deleted_at", { ascending: false })
            .limit(50);
          if (error) return [] as DeletedItem[];
          return (data ?? []).map((r) =>
            toDeletedItem(type, r as unknown as Record<string, unknown>)
          );
        })
      );

      let all = perType.flat();
      if (!include_demo) all = all.filter((i) => !isDemoFixture(i));
      all.sort((a, b) =>
        a.deleted_at < b.deleted_at ? 1 : a.deleted_at > b.deleted_at ? -1 : 0
      );

      // Attribution: fold in who soft-deleted each item from the audit
      // trail. Read via ctx.admin (audit_log SELECT is RLS-denied to the
      // user-scoped client under hosted mode) and scope by company_id since
      // admin bypasses RLS. One bounded query (the trash is capped above).
      const ids = all.map((i) => i.entity_id);
      let auditIdx = new Map<string, AuditDeleteRow>();
      if (ids.length > 0) {
        const { data: auditRows } = await ctx.admin
          .from("audit_log")
          .select("entity_id, actor_id, metadata, created_at")
          .eq("company_id", companyId)
          .in("entity_id", ids)
          .like("action", "delete_%")
          .order("created_at", { ascending: false });
        auditIdx = indexLatestDeleteAudit((auditRows ?? []) as AuditDeleteRow[]);
      }

      let enriched = all.map((i) => ({ item: i, attr: attributionFor(i.entity_id, auditIdx) }));
      if (deleted_by_kind) {
        enriched = enriched.filter((e) => e.attr.deleted_by_kind === deleted_by_kind);
      }
      const total = enriched.length;

      const items = enriched.slice(0, limit).map(({ item: i, attr }) => ({
        entity_type: i.entity_type,
        entity_id: i.entity_id,
        label: i.label,
        deleted_at: i.deleted_at,
        recoverable_until: new Date(
          new Date(i.deleted_at).getTime() + 30 * 86_400_000
        ).toISOString(),
        deleted_by_kind: attr.deleted_by_kind,
        deleted_run_id: attr.deleted_run_id,
      }));

      const byKindLabel = (k: DeletedByKind) =>
        k === "autonomous" ? "automation" : k === "interactive" ? "a person" : "unknown";

      const markdown = items.length
        ? "| Type | Item | Deleted by | Deleted | Recoverable until |\n|------|------|------------|---------|-------------------|\n" +
          items
            .map(
              (i) =>
                `| ${i.entity_type.replace(/_/g, " ")} | ${i.label} | ${byKindLabel(i.deleted_by_kind)} | ${i.deleted_at.slice(0, 10)} | ${i.recoverable_until.slice(0, 10)} |`
            )
            .join("\n")
        : deleted_by_kind === "autonomous"
          ? `The agent has not deleted anything in the last ${days} day${days === 1 ? "" : "s"}.`
          : `No deleted items in the last ${days} day${days === 1 ? "" : "s"}.`;

      const render: Render = {
        tier_1: {
          format_hint: "table",
          instructions: {
            scope:
              "render the `items` array as the recoverable trash, grouped by entity_type; show label, who deleted it (deleted_by_kind: 'automation' for autonomous, 'a person' for interactive, 'unknown' otherwise), deleted_at, and recoverable_until per row, with total as the headline.",
            format:
              "table or grouped list with a type label per group; show the human label prominently, surface deleted_by_kind as a small badge (call out automation-deleted items so the user can see what the agent removed), and keep the deleted / recoverable dates as secondary detail. Give every row a one-click Restore action wired with sendPrompt(`restore the <entity_type> \"<label>\"`) so the user can recall it without typing an id, and offer a single 'Restore all' affordance wired with sendPrompt('restore all items in the trash'). Recovery is the primary action; keep it visually dominant.",
            forbidden:
              "do not display entity_id or deleted_run_id to the user; do not invent items not in the array; do not present this as full history - it is only the recoverable window; do not offer permanent-delete (purge) as a primary action - recovery is the point of this view.",
          },
        },
        tier_3: { markdown },
        do_not: [
          "Do not show entity_id to the user.",
          "For 2 or fewer items, inline rendering is fine.",
        ],
      } satisfies Render;

      return {
        items,
        total,
        window_days: days,
        demo_hidden: !include_demo,
        deleted_by_kind: deleted_by_kind ?? null,
        hint:
          "To recover an item, call restore_item with its entity_type and entity_id. To permanently delete it, call purge_item (it returns a confirmation prompt first). Pass deleted_by_kind: 'autonomous' to see only what the agent deleted.",
        render,
      };
    },
  },

  purge_item: {
    title: "Permanently Delete Item",
    description:
      "Permanently and irreversibly delete a soft-deleted item (purge it from the trash, skipping the 30-day recovery window). Only operates on items that are already soft-deleted - it refuses items that are still active. On the first call it returns a confirmation conflict; pass resolution: \"confirm\" only after the user explicitly agrees, or \"cancel\" to abort. Cascades to child rows the database cascades (e.g. a customer's contacts and interactions). To recover an item instead of destroying it, use restore_item.",
    parameters: z.object({
      entity_type: z
        .enum(ENTITY_TYPES)
        .describe("Type of soft-deleted entity to purge."),
      entity_id: z
        .string()
        .uuid()
        .describe("UUID of the soft-deleted entity."),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe(
          'Pass "confirm" to permanently delete after the user agrees; "cancel" to abort. Omit on the first call to receive a confirmation prompt.'
        ),
    }),
    handler: async (ctx: ToolContext, {
      entity_type,
      entity_id,
      resolution,
    }: {
      entity_type: RestorableEntity;
      entity_id: string;
      resolution?: "confirm" | "cancel";
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const config = RESTORE_CONFIG[entity_type];

      const { data: entity, error: fetchErr } = await supabase
        .from(config.table)
        .select("*")
        .eq("id", entity_id)
        .single();
      if (fetchErr || !entity) {
        throw new Error(
          `${entity_type} not found: ${fetchErr?.message ?? "no match"}`
        );
      }

      const entityCompanyId = await resolveEntityCompany(
        supabase,
        entity_type,
        entity
      );
      if (entityCompanyId !== companyId) {
        return {
          error: "permission_denied",
          message: "This item belongs to a different organization.",
        };
      }

      if (entity.deleted_at == null) {
        return {
          success: false,
          message: `This ${entity_type.replace(/_/g, " ")} is not in the trash - only soft-deleted items can be permanently purged.`,
        };
      }

      const scope =
        config.scope === "check" && config.scopeColumn
          ? (entity[config.scopeColumn] as "personal" | "org")
          : "org";
      const perm = await canRestore(ctx, {
        scope,
        created_by: config.createdByColumn
          ? (entity[config.createdByColumn] as string | undefined)
          : undefined,
        company_id: entityCompanyId,
      });
      if (!perm.allowed) {
        return { error: "permission_denied", message: perm.reason };
      }

      const label =
        entity_type === "contact"
          ? `${entity.first_name} ${entity.last_name}`
          : (entity[config.labelColumn] as string) ?? entity_id;

      if (resolution === "cancel") {
        return {
          success: false,
          action: "cancelled",
          message: `"${label}" was left in the trash.`,
        };
      }

      if (resolution !== "confirm") {
        return conflict(
          "destructive_action",
          `Permanently delete "${label}"? This cannot be undone and skips the 30-day recovery window.`,
          [
            {
              key: "confirm",
              label: `Permanently delete "${label}"`,
              value: { entity_type, entity_id, resolution: "confirm" },
            },
            {
              key: "cancel",
              label: "Keep it in the trash",
              value: { entity_type, entity_id, resolution: "cancel" },
            },
          ],
          { entity_type, entity_id, entity_label: label }
        );
      }

      const { error: delErr } = await supabase
        .from(config.table)
        .delete()
        .eq("id", entity_id)
        .not("deleted_at", "is", null);
      if (delErr) {
        throw new Error(
          `Could not permanently delete ${entity_type.replace(/_/g, " ")} "${label}": ${delErr.message}. ` +
            "It may still be referenced by other records (e.g. transactions) - reassign or purge those first."
        );
      }

      await writeAuditLog(ctx, {
        action: `purge_${entity_type}`,
        entity_type,
        entity_id,
        before_state: { label, deleted_at: entity.deleted_at },
        after_state: null,
      });

      return {
        success: true,
        action: "purged",
        entity_type,
        entity_id,
        entity_label: label,
        message: `"${label}" has been permanently deleted.`,
      };
    },
  },
  purge_items: {
    title: "Batch Permanently Delete Items",
    description:
      "Permanently and irreversibly delete many soft-deleted items at once (batch purge from the trash). Provide either an explicit `items` list (entity_type + entity_id pairs, e.g. gathered from list_deleted) OR filters: entity_type, older_than_days, only_demo (leftover demo/test fixtures), or all. On the first call it returns a confirmation conflict summarizing how many items of each type will be destroyed; pass resolution: \"confirm\" only after the user explicitly agrees. Only ever touches already-soft-deleted items; cascades to child rows the database cascades. Use restore_items to recover instead.",
    parameters: z.object({
      items: z
        .array(z.object({ entity_type: z.enum(ENTITY_TYPES), entity_id: z.string().uuid() }))
        .optional()
        .describe("Explicit items to purge. Provide this OR filters."),
      entity_type: z.enum(ENTITY_TYPES).optional().describe("Filter: only this entity type."),
      older_than_days: z.number().optional().describe("Filter: only items deleted more than N days ago."),
      only_demo: z.boolean().optional().describe("Filter: only leftover demo / test fixtures."),
      all: z.boolean().optional().describe("Filter: every recoverable item in the trash. Use with care."),
      days: z.number().optional().describe("Filter look-back window in days. Defaults to 30."),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe('Pass "confirm" after the user agrees, "cancel" to abort. Omit on the first call to get a confirmation prompt.'),
    }),
    handler: async (ctx: ToolContext, p: BatchSelect & { resolution?: "confirm" | "cancel" }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;

      if ((!p.items || p.items.length === 0) && !hasBatchFilter(p)) {
        return {
          error: "no_selection",
          message: "Provide items to purge, or a filter (entity_type, older_than_days, only_demo, or all).",
        };
      }

      const targets = await resolveBatchTargets(supabase, companyId, p);
      if (targets.length === 0) {
        return { success: true, purged_count: 0, message: "Nothing matched - the trash had no items for that selection." };
      }

      if (p.resolution === "cancel") {
        return { success: false, action: "cancelled", message: `Cancelled. ${targets.length} item(s) left in the trash.` };
      }

      if (p.resolution !== "confirm") {
        const retry: Record<string, unknown> = { resolution: "confirm" };
        if (p.items && p.items.length > 0) {
          retry.items = p.items;
        } else {
          if (p.entity_type) retry.entity_type = p.entity_type;
          if (p.older_than_days != null) retry.older_than_days = p.older_than_days;
          if (p.only_demo) retry.only_demo = p.only_demo;
          if (p.all) retry.all = p.all;
          if (p.days != null) retry.days = p.days;
        }
        return conflict(
          "destructive_action",
          `Permanently delete ${targets.length} item(s)? This cannot be undone and skips the 30-day recovery window.`,
          [
            { key: "confirm", label: `Permanently delete ${targets.length} item(s)`, value: retry },
            { key: "cancel", label: "Keep them in the trash", value: { resolution: "cancel" } },
          ],
          { count: targets.length, by_type: countByType(targets), sample: targets.slice(0, 20).map((t) => `${t.entity_type.replace(/_/g, " ")}: ${t.label}`) }
        );
      }

      const ordered = [...targets].sort((a, b) => PURGE_RANK[a.entity_type] - PURGE_RANK[b.entity_type]);
      const purged: BatchTarget[] = [];
      const blocked: { entity_type: string; label: string; reason: string }[] = [];
      const skipped: { entity_type: string; label: string; reason: string }[] = [];
      for (const t of ordered) {
        const out = await purgeOne(ctx, supabase, companyId, t.entity_type, t.entity_id);
        if (out.status === "purged") {
          purged.push({ entity_type: t.entity_type, entity_id: t.entity_id, label: out.label });
        } else if (out.status === "blocked") {
          blocked.push({ entity_type: t.entity_type, label: out.label, reason: out.message ?? "blocked" });
        } else if (out.status === "not_found") {
          skipped.push({ entity_type: t.entity_type, label: out.label, reason: "already removed (cascaded)" });
        } else {
          skipped.push({ entity_type: t.entity_type, label: out.label, reason: out.message ?? out.status });
        }
      }

      return {
        success: true,
        action: "purged",
        purged_count: purged.length,
        blocked_count: blocked.length,
        skipped_count: skipped.length,
        purged,
        blocked,
        skipped,
        message:
          `Permanently deleted ${purged.length} item(s).` +
          (blocked.length ? ` ${blocked.length} blocked (still referenced).` : "") +
          (skipped.length ? ` ${skipped.length} skipped.` : ""),
      };
    },
  },

  restore_items: {
    title: "Batch Restore Items",
    description:
      "Restore many soft-deleted items at once (batch recover from the trash). Provide either an explicit `items` list (entity_type + entity_id pairs) OR filters: entity_type, older_than_days, or all. Restores are reversible - you can delete the items again - so this executes directly and returns a summary of what was recovered. Use purge_items to permanently delete instead.",
    parameters: z.object({
      items: z
        .array(z.object({ entity_type: z.enum(ENTITY_TYPES), entity_id: z.string().uuid() }))
        .optional()
        .describe("Explicit items to restore. Provide this OR filters."),
      entity_type: z.enum(ENTITY_TYPES).optional().describe("Filter: only this entity type."),
      older_than_days: z.number().optional().describe("Filter: only items deleted more than N days ago."),
      all: z.boolean().optional().describe("Filter: every recoverable item in the trash."),
      days: z.number().optional().describe("Filter look-back window in days. Defaults to 30."),
    }),
    handler: async (ctx: ToolContext, p: BatchSelect) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;

      const hasFilter = Boolean(p.all || p.entity_type || p.older_than_days != null);
      if ((!p.items || p.items.length === 0) && !hasFilter) {
        return {
          error: "no_selection",
          message: "Provide items to restore, or a filter (entity_type, older_than_days, or all).",
        };
      }

      const targets = await resolveBatchTargets(supabase, companyId, { ...p, only_demo: false });
      if (targets.length === 0) {
        return { success: true, restored_count: 0, message: "Nothing matched - the trash had no items for that selection." };
      }

      const restored: BatchTarget[] = [];
      const skipped: { entity_type: string; label: string; reason: string }[] = [];
      for (const t of targets) {
        const out = await restoreOne(ctx, supabase, companyId, t.entity_type, t.entity_id);
        if (out.status === "restored") {
          restored.push({ entity_type: t.entity_type, entity_id: t.entity_id, label: out.label });
        } else {
          skipped.push({ entity_type: t.entity_type, label: out.label, reason: out.message ?? out.status });
        }
      }

      return {
        success: true,
        action: "restored",
        restored_count: restored.length,
        skipped_count: skipped.length,
        restored,
        skipped,
        message: `Restored ${restored.length} item(s).` + (skipped.length ? ` ${skipped.length} skipped.` : ""),
      };
    },
  },
};

export function registerRestoreTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, restoreTools, ctx);
}
