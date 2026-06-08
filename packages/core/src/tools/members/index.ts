// ============================================================
// Founders OS — Member Management Tools
// ============================================================
// 4 tools:
//   list_members      — any member; lists all company members
//   add_member        — owner-only; creates a member row
//   set_member_owner  — owner-only; promotes/demotes owner status
//   remove_member     — owner-only; removes a member from the company
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import {
  isOwner,
  isLastOwner,
  ownerPermissionError,
  getFinancialAccess,
  type FinancialAccessLevel,
} from "../financial/access.js";
import { writeAuditLog } from "../audit.js";
import type { ToolContext } from "../../types/context.js";

// access.ts helpers (isOwner / isLastOwner / getFinancialAccess) and
// writeAuditLog are fully contextual (refactors 2026-05-28) and threaded
// through ctx. getFinancialAccess is a pre-existing unused import; kept
// to minimize churn.
void getFinancialAccess;

export const memberTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // list_members
  // ──────────────────────────────────────────────────────────
  list_members: {
    title: "List Members",
    description:
      "List all team members in this company with their owner status and financial access level. " +
      "Any member can call this — you don't need to be an owner to see the roster.",
    parameters: z.object({}),
    handler: async (ctx: ToolContext, _params: Record<string, never>) => {
      // _params is the empty input object; we accept it so the dispatcher
      // sees handler.length === 2 and routes this as a contextual handler.
      void _params;
      // Solo mode: synthesize a single-member result
      if (ctx.isSoloMode) {
        return {
          members: [
            {
              user_id: ctx.userId,
              display_name: null,
              is_owner: true,
              financial_access: "write",
              created_at: null,
              note: "Solo mode — no company_members rows exist. This user has full owner access by default.",
            },
          ],
          count: 1,
          owner_count: 1,
        };
      }

      const { data, error } = await ctx.db
        .from("company_members")
        .select("user_id, display_name, is_owner, financial_access, created_at")
        .eq("company_id", ctx.companyId)
        .order("created_at", { ascending: true });

      if (error) throw new Error(`Failed to list members: ${error.message}`);

      const members = data ?? [];
      return {
        members,
        count: members.length,
        owner_count: members.filter((m: { is_owner: boolean }) => m.is_owner).length,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // add_member
  // ──────────────────────────────────────────────────────────
  add_member: {
    title: "Add Member",
    description:
      "Add a team member to the company. Creates their company_members row with default access " +
      "(no financial access, not an owner). Use set_financial_access to grant financial access, " +
      "and set_member_owner to grant owner status. Requires owner role.",
    parameters: z.object({
      user_id: z
        .string()
        .describe(
          "The user_id for the new member — must match the FOUNDERS_OS_USER_ID they will set in their MCP config."
        ),
      display_name: z
        .string()
        .optional()
        .describe("Human-readable name (improves audit log legibility)."),
      financial_access: z
        .enum(["none", "read", "write"])
        .optional()
        .describe("Financial access level. Defaults to 'none'."),
    }),
    handler: async (ctx: ToolContext, {
        user_id,
        display_name,
        financial_access = "none",
      }: {
        user_id: string;
        display_name?: string;
        financial_access?: FinancialAccessLevel;
      }
    ) => {
      if (!(await isOwner(ctx))) return ownerPermissionError();

      const companyId = ctx.companyId;

      // Check if already exists
      const { data: existing } = await ctx.db
        .from("company_members")
        .select("user_id, display_name, is_owner, financial_access")
        .eq("company_id", companyId)
        .eq("user_id", user_id)
        .single();

      if (existing) {
        return {
          already_exists: true,
          member: existing,
          message: `Member '${user_id}' already exists in this company. Use set_financial_access or set_member_owner to update their access.`,
        };
      }

      const { data, error } = await ctx.db
        .from("company_members")
        .insert({
          company_id: companyId,
          user_id,
          display_name: display_name ?? null,
          is_owner: false,
          financial_access,
        })
        .select("user_id, display_name, is_owner, financial_access, created_at")
        .single();

      if (error) throw new Error(`Failed to add member: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "add_member",
        entity_type: "company_member",
        entity_id: user_id,
        after_state: { user_id, display_name: display_name ?? null, financial_access, is_owner: false },
        metadata: { added_by: ctx.userId },
      });

      return {
        success: true,
        member: data,
        message: `Member '${user_id}' added with financial_access: '${financial_access}'. They are not an owner.`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // set_member_owner
  // ──────────────────────────────────────────────────────────
  set_member_owner: {
    title: "Set Member Owner",
    description:
      "Promote or demote a team member's owner status. Owners can manage financial access, " +
      "add/remove members, and read the audit log. " +
      "Promoting automatically grants 'write' financial access. " +
      "You cannot demote the last remaining owner — add another owner first. " +
      "Requires owner role.",
    parameters: z.object({
      target_user_id: z
        .string()
        .describe("The user_id of the member to update."),
      is_owner: z
        .boolean()
        .describe("true = promote to owner, false = demote from owner."),
    }),
    handler: async (ctx: ToolContext, {
        target_user_id,
        is_owner: targetIsOwner,
      }: {
        target_user_id: string;
        is_owner: boolean;
      }
    ) => {
      if (!(await isOwner(ctx))) return ownerPermissionError();

      // Last-owner protection: cannot demote last owner
      if (!targetIsOwner && (await isLastOwner(ctx, target_user_id))) {
        return {
          error: "last_owner_protection",
          message:
            "This is the last owner in the company. Promote another member to owner first, " +
            "then demote this one.",
        };
      }

      const companyId = ctx.companyId;

      // Fetch current state for audit snapshot
      const { data: existing } = await ctx.db
        .from("company_members")
        .select("user_id, display_name, is_owner, financial_access")
        .eq("company_id", companyId)
        .eq("user_id", target_user_id)
        .single();

      const beforeState = existing
        ? { is_owner: existing.is_owner, financial_access: existing.financial_access }
        : null;

      // On promote: upsert with is_owner: true and financial_access: write
      // On demote: update is_owner to false (preserve financial_access)
      const updatePayload = targetIsOwner
        ? { is_owner: true, financial_access: "write" as FinancialAccessLevel }
        : { is_owner: false };

      const { data, error } = await ctx.db
        .from("company_members")
        .upsert(
          {
            company_id: companyId,
            user_id: target_user_id,
            ...updatePayload,
            // Preserve display_name on update; set null on insert
            ...(existing ? {} : { display_name: null, financial_access: "write" as FinancialAccessLevel }),
          },
          { onConflict: "company_id,user_id" }
        )
        .select("user_id, display_name, is_owner, financial_access")
        .single();

      if (error) throw new Error(`Failed to update owner status: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "set_member_owner",
        entity_type: "company_member",
        entity_id: target_user_id,
        before_state: beforeState,
        after_state: { is_owner: data.is_owner, financial_access: data.financial_access },
        metadata: { changed_by: ctx.userId },
      });

      const verb = targetIsOwner ? "promoted to" : "demoted from";
      return {
        success: true,
        member: data,
        message: `User '${target_user_id}' ${verb} owner.${targetIsOwner ? " Financial access set to 'write'." : ""}`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_member
  // ──────────────────────────────────────────────────────────
  remove_member: {
    title: "Remove Member",
    description:
      "Remove a team member from the company. Deletes their company_members row, " +
      "revoking all financial access. Their historical data (tasks, interactions, transactions) " +
      "is preserved. Cannot remove the last owner. Requires owner role.",
    parameters: z.object({
      target_user_id: z
        .string()
        .describe("The user_id of the member to remove."),
    }),
    handler: async (ctx: ToolContext, { target_user_id }: { target_user_id: string }
    ) => {
      if (!(await isOwner(ctx))) return ownerPermissionError();

      // Prevent removing self if last owner
      if (await isLastOwner(ctx, target_user_id)) {
        return {
          error: "last_owner_protection",
          message:
            "Cannot remove the last owner. Promote another member to owner first, " +
            "or transfer ownership before removing this account.",
        };
      }

      const companyId = ctx.companyId;

      // Fetch before state for audit log
      const { data: existing, error: fetchErr } = await ctx.db
        .from("company_members")
        .select("user_id, display_name, is_owner, financial_access")
        .eq("company_id", companyId)
        .eq("user_id", target_user_id)
        .single();

      if (fetchErr || !existing) {
        return {
          error: "not_found",
          message: `No member found with user_id '${target_user_id}' in this company.`,
        };
      }

      const { error } = await ctx.db
        .from("company_members")
        .delete()
        .eq("company_id", companyId)
        .eq("user_id", target_user_id);

      if (error) throw new Error(`Failed to remove member: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "remove_member",
        entity_type: "company_member",
        entity_id: target_user_id,
        before_state: {
          user_id: existing.user_id,
          display_name: existing.display_name,
          is_owner: existing.is_owner,
          financial_access: existing.financial_access,
        },
        after_state: null,
        metadata: { removed_by: ctx.userId },
      });

      return {
        success: true,
        removed_member: existing,
        message: `Member '${target_user_id}' removed. Their historical data is preserved.`,
      };
    },
  },
};

export function registerMemberTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, memberTools, ctx);
}
