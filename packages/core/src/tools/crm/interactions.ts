import { z } from "zod";
import { conflict } from "../conflict.js";
import { writeAuditLog } from "../audit.js";
import type { ToolContext } from "../../types/context.js";

export const interactionTools = {
  log_interaction: {
    title: "Log Interaction",
    description:
      "Record an interaction with a customer (email, call, meeting, demo, support ticket, event, or general note).",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID"),
      contact_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional: specific contact this interaction was with"),
      interaction_type: z
        .enum(["email", "call", "meeting", "demo", "support", "event", "note"])
        .describe("Type of interaction"),
      subject: z.string().optional().describe("Brief subject or title for this interaction"),
      body: z.string().optional().describe("Full details, notes, or transcript of the interaction"),
      interaction_date: z
        .string()
        .optional()
        .describe("When it happened (ISO 8601). Defaults to now if omitted."),
    }),
    handler: async (ctx: ToolContext, params: {
      customer_id: string;
      contact_id?: string;
      interaction_type: string;
      subject?: string;
      body?: string;
      interaction_date?: string;
    }) => {
      const { data, error } = await ctx.db
        .from("interactions")
        .insert({
          company_id: ctx.companyId,
          customer_id: params.customer_id,
          contact_id: params.contact_id || null,
          interaction_type: params.interaction_type,
          subject: params.subject || null,
          body: params.body || null,
          interaction_date: params.interaction_date || new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw new Error(`Failed to log interaction: ${error.message}`);
      return { success: true, interaction: data };
    },
  },

  list_interactions: {
    title: "List Interactions",
    description: "Get interaction history for a customer, with optional date range and type filter.",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID"),
      interaction_type: z
        .enum(["email", "call", "meeting", "demo", "support", "event", "note"])
        .optional()
        .describe("Filter by interaction type"),
      from_date: z
        .string()
        .optional()
        .describe("Only show interactions on or after this date (ISO 8601)"),
      to_date: z
        .string()
        .optional()
        .describe("Only show interactions on or before this date (ISO 8601)"),
      since: z
        .string()
        .optional()
        .describe("Deprecated: use `from_date`."),
      until: z
        .string()
        .optional()
        .describe("Deprecated: use `to_date`."),
      limit: z.number().min(1).max(100).default(50).describe("Max results"),
    }),
    handler: async (ctx: ToolContext, params: {
      customer_id: string;
      interaction_type?: string;
      from_date?: string;
      to_date?: string;
      since?: string;
      until?: string;
      limit?: number;
    }) => {
      let query = ctx.db
        .from("interactions")
        .select("*, contacts(first_name, last_name)")
        .eq("company_id", ctx.companyId)
        .eq("customer_id", params.customer_id)
        .is("deleted_at", null)
        .is("contacts.deleted_at", null)
        .order("interaction_date", { ascending: false })
        .limit(params.limit || 50);

      if (params.interaction_type) {
        query = query.eq("interaction_type", params.interaction_type);
      }
      const fromDate = params.from_date ?? params.since;
      const toDate = params.to_date ?? params.until;
      if (fromDate) {
        query = query.gte("interaction_date", fromDate);
      }
      if (toDate) {
        query = query.lte("interaction_date", toDate);
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list interactions: ${error.message}`);

      return { interactions: data || [], count: data?.length || 0 };
    },
  },

  remove_interaction: {
    title: "Remove Interaction",
    description:
      "Soft-delete a logged interaction (email, call, meeting, etc.) by its UUID. " +
      "Interactions are append-only touchpoint history, so there is no archive state - " +
      "removal is a soft-delete, recoverable for 30 days, then purged. " +
      "On first call returns a `conflict` with DELETE / CANCEL options; pass mode after the user decides.",
    parameters: z.object({
      interaction_id: z.string().uuid().describe("Interaction UUID to remove."),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Resolution: 'confirm' soft-deletes (recoverable 30 days), 'cancel' aborts."),
      mode: z
        .enum(["delete", "cancel"])
        .optional()
        .describe("Deprecated: use `resolution`. 'delete' / 'cancel'."),
    }),
    handler: async (ctx: ToolContext, params: { interaction_id: string; mode?: "delete" | "cancel"; resolution?: "confirm" | "cancel" }) => {
      const { interaction_id, mode, resolution } = params;

      // Fetch the interaction (must belong to this company and not already deleted)
      const { data: interaction, error: fetchErr } = await ctx.db
        .from("interactions")
        .select("id, subject, interaction_type, customer_id, company_id, deleted_at")
        .eq("id", interaction_id)
        .eq("company_id", ctx.companyId)
        .single();

      if (fetchErr) throw new Error(`Interaction not found: ${fetchErr.message}`);
      if (interaction.deleted_at) {
        return { success: false, message: "Interaction is already deleted." };
      }

      const label = interaction.subject || `${interaction.interaction_type} interaction`;

      // No resolution yet - return a delete/cancel conflict (no archive for append-only history)
      if (!resolution && !mode) {
        return conflict(
          "destructive_action",
          `You are about to delete "${label}". This is recoverable for 30 days, then permanently purged. Choose an action:`,
          [
            {
              key: "delete",
              label: "Delete - Remove (recoverable for 30 days, then permanently purged)",
              value: { resolution: "confirm" },
            },
            {
              key: "cancel",
              label: "Cancel - Do nothing",
              value: { resolution: "cancel" },
            },
          ],
          { entity_type: "interaction", entity_id: interaction_id }
        );
      }

      if (resolution === "cancel" || mode === "cancel") {
        return { success: false, message: "Operation cancelled. No changes were made." };
      }

      // mode === "delete"
      const deletedAt = new Date();
      const { data, error } = await ctx.db
        .from("interactions")
        .update({ deleted_at: deletedAt.toISOString() })
        .eq("id", interaction_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();
      if (error) throw new Error(`Failed to delete interaction: ${error.message}`);

      await writeAuditLog(ctx, {
        action: "delete_interaction",
        entity_type: "interaction",
        entity_id: interaction_id,
        before_state: {
          subject: interaction.subject,
          interaction_type: interaction.interaction_type,
          customer_id: interaction.customer_id,
        },
        after_state: { deleted_at: deletedAt.toISOString() },
      });

      const recoverableUntil = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

      return {
        success: true,
        action: "deleted",
        entity_type: "interaction",
        entity_id: interaction_id,
        entity_label: label,
        recoverable_until: recoverableUntil,
        message: `"${label}" has been deleted. Recoverable until ${recoverableUntil} if you change your mind.`,
        data,
      };
    },
  },
};
