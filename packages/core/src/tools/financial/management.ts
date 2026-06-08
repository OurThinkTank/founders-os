// ============================================================
// Founders OS — Financial Access Management Tools
// ============================================================
// 3 tools:
//   set_financial_access  — owner-only; grants/revokes access
//   get_financial_access  — any user (own access); owner (any user)
//   get_audit_log         — owner-only; immutable access history
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import {
  getFinancialAccess,
  isOwner,
  isLastOwner,
  ownerPermissionError,
  writeAuditLog,
  type FinancialAccessLevel,
} from "./access.js";
import { AUDIT_DOMAINS } from "../audit.js";
import type { ToolContext } from "../../types/context.js";

export const financialManagementTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // set_financial_access
  // ──────────────────────────────────────────────────────────
  set_financial_access: {
    title: "Set Financial Access",
    description:
      "Grant or restrict a team member's access to financial tools. " +
      "Requires owner role. " +
      "Access levels: 'none' = no financial tools; 'read' = view only (balances, transactions, reports); " +
      "'write' = full access including add, edit, and delete. " +
      "Owners cannot set their own access to 'none' or 'read' if they are the last owner — " +
      "this would lock the company out of financial management.",
    parameters: z.object({
      target_user_id: z
        .string()
        .describe("The user_id of the team member to update (matches FOUNDERS_OS_USER_ID)."),
      level: z
        .enum(["none", "read", "write"])
        .describe("The financial access level to assign."),
    }),
    handler: async (
      ctx: ToolContext,
      {
        target_user_id,
        level,
      }: {
        target_user_id: string;
        level: FinancialAccessLevel;
      }
    ) => {
      // Caller must be an owner. access.ts helpers are contextual
      // (refactor 2026-05-28): isOwner(ctx) / isLastOwner(ctx, ...) /
      // getFinancialAccess(ctx) all use ctx.db / ctx.companyId / ctx.userId.
      if (!(await isOwner(ctx))) return ownerPermissionError();

      // Prevent the last owner from downgrading their own write access
      if (
        target_user_id === ctx.userId &&
        level !== "write" &&
        (await isLastOwner(ctx, target_user_id))
      ) {
        return {
          error: "last_owner_protection",
          message:
            "You are the only owner in this company. Owners cannot remove their own " +
            "write financial access — this would leave the company unable to manage its books. " +
            "Add another owner first, then adjust your access if needed.",
        };
      }

      // Fetch the current state for the audit log before/after snapshot
      const { data: existing } = await ctx.db
        .from("company_members")
        .select("id, financial_access, is_owner")
        .eq("company_id", ctx.companyId)
        .eq("user_id", target_user_id)
        .single();

      const beforeState = existing
        ? { financial_access: existing.financial_access, is_owner: existing.is_owner }
        : null;

      // Upsert: create the member row if it doesn't exist yet
      const { data, error } = await ctx.db
        .from("company_members")
        .upsert(
          {
            company_id: ctx.companyId,
            user_id: target_user_id,
            financial_access: level,
            // is_owner defaults to false on insert; preserved on update
            ...(existing ? {} : { is_owner: false }),
          },
          { onConflict: "company_id,user_id" }
        )
        .select("id, user_id, is_owner, financial_access")
        .single();

      if (error) throw new Error(`Failed to update financial access: ${error.message}`);

      // Write immutable audit entry
      await writeAuditLog(ctx, {
        action: "set_financial_access",
        entity_type: "company_member",
        entity_id: target_user_id,
        before_state: beforeState,
        after_state: { financial_access: level, is_owner: data.is_owner },
        metadata: { changed_by: ctx.userId },
      });

      return {
        success: true,
        member: data,
        message: `Financial access for user '${target_user_id}' set to '${level}'.`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_financial_access
  // ──────────────────────────────────────────────────────────
  get_financial_access: {
    title: "Get Financial Access",
    description:
      "Check a user's financial access level. " +
      "Any user can check their own access. " +
      "Owners can check any user by passing target_user_id.",
    parameters: z.object({
      target_user_id: z
        .string()
        .optional()
        .describe(
          "The user_id to check. Omit to check your own access level."
        ),
    }),
    handler: async (ctx: ToolContext, { target_user_id }: { target_user_id?: string }) => {
      const callerId = ctx.userId;
      const targetId = target_user_id ?? callerId;

      // Non-owners can only check their own access.
      if (targetId !== callerId && !(await isOwner(ctx))) {
        return ownerPermissionError();
      }

      // Caller's own access (uses the cached helper)
      if (targetId === callerId) {
        const level = await getFinancialAccess(ctx);
        const callerIsOwner = await isOwner(ctx);
        return {
          user_id: callerId,
          financial_access: level,
          is_owner: callerIsOwner,
          note:
            level === "none"
              ? "You do not have access to any financial tools. Contact an owner to request access."
              : level === "read"
              ? "You can view financial data but cannot add, modify, or delete entries."
              : "You have full financial access.",
        };
      }

      // Owner checking another user
      const { data, error } = await ctx.db
        .from("company_members")
        .select("user_id, is_owner, financial_access")
        .eq("company_id", ctx.companyId)
        .eq("user_id", targetId)
        .single();

      if (error || !data) {
        return {
          user_id: targetId,
          financial_access: "write",
          is_owner: true,
          note: "No member record found — this user is operating in solo/owner mode with full write access.",
        };
      }

      return {
        user_id: data.user_id,
        financial_access: data.financial_access,
        is_owner: data.is_owner,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_audit_log
  // ──────────────────────────────────────────────────────────
  get_audit_log: {
    title: "Get Audit Log",
    description:
      "Read the immutable audit log for this company. " +
      "Owners can read all entries (scope='all'). " +
      "Any member can read their own entries (scope='mine'). " +
      "Covers financial transactions, CRM deletes, org memory changes, playbook runs, " +
      "access management, and member changes. " +
      "Records cannot be modified or deleted.",
    parameters: z.object({
      scope: z
        .enum(["all", "mine"])
        .optional()
        .describe(
          "'all' returns all company entries (owner-only). " +
          "'mine' returns only your own actions (any member). " +
          "Defaults to 'all' for owners, 'mine' for non-owners."
        ),
      domain: z
        .enum(["financial", "crm", "memory", "playbooks", "access", "members"])
        .optional()
        .describe(
          "Filter by domain group. " +
          "'financial' = transactions, accounts, categories. " +
          "'crm' = customer and tag deletes. " +
          "'memory' = org-scoped memory store/forget. " +
          "'playbooks' = playbook runs. " +
          "'access' = financial access changes. " +
          "'members' = member add/remove/promote."
        ),
      action: z
        .string()
        .optional()
        .describe("Filter by exact action name (e.g. 'add_transaction', 'run_playbook')."),
      actor_id: z
        .string()
        .optional()
        .describe("Filter by the user_id who performed the action."),
      entity_id: z
        .string()
        .optional()
        .describe("Filter by the affected record UUID (e.g. a specific account_id or customer_id)."),
      entity_type: z
        .string()
        .optional()
        .describe("Filter by entity type (e.g. 'financial_transaction', 'customer')."),
      from_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Return entries on or after this date (YYYY-MM-DD)."),
      to_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Return entries on or before this date (YYYY-MM-DD)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max results (default 50)."),
    }),
    handler: async (
      ctx: ToolContext,
      {
        scope,
        domain,
        action,
        actor_id,
        entity_id,
        entity_type,
        from_date,
        to_date,
        limit = 50,
      }: {
        scope?: "all" | "mine";
        domain?: keyof typeof AUDIT_DOMAINS;
        action?: string;
        actor_id?: string;
        entity_id?: string;
        entity_type?: string;
        from_date?: string;
        to_date?: string;
        limit?: number;
      }
    ) => {
      const callerIsOwner = await isOwner(ctx);
      const callerId = ctx.userId;

      // Determine effective scope
      const effectiveScope = scope ?? (callerIsOwner ? "all" : "mine");

      // Non-owners can only access their own entries
      if (effectiveScope === "all" && !callerIsOwner) {
        return ownerPermissionError();
      }

      let query = ctx.db
        .from("audit_log")
        .select("id, actor_id, action, entity_type, entity_id, before_state, after_state, metadata, created_at")
        .eq("company_id", ctx.companyId)
        .order("created_at", { ascending: false })
        .limit(limit);

      // Scope filter
      if (effectiveScope === "mine") query = query.eq("actor_id", callerId);

      // Domain filter: map to action name set
      if (domain) {
        const domainActions = AUDIT_DOMAINS[domain];
        if (domainActions && domainActions.length > 0) {
          query = query.in("action", domainActions);
        }
      }

      if (action)      query = query.eq("action", action);
      if (actor_id)    query = query.eq("actor_id", actor_id);
      if (entity_id)   query = query.eq("entity_id", entity_id);
      if (entity_type) query = query.eq("entity_type", entity_type);
      if (from_date)   query = query.gte("created_at", from_date);
      if (to_date)     query = query.lte("created_at", to_date + "T23:59:59Z");

      const { data, error } = await query;
      if (error) throw new Error(`Failed to read audit log: ${error.message}`);

      return {
        entries: data ?? [],
        count: data?.length ?? 0,
        scope: effectiveScope,
        note: "Audit log is immutable. Entries cannot be modified or deleted.",
      };
    },
  },
};

export function registerFinancialManagementTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, financialManagementTools, ctx);
}
