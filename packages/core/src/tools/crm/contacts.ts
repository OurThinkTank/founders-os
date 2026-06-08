import { z } from "zod";
import { sanitizeSearchQuery } from "../../utils/sanitize.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import type { ToolContext } from "../../types/context.js";

export const contactTools = {
  add_contact: {
    title: "Add Contact",
    description:
      "Add a contact person to a customer organization. Contacts are individuals you interact with at that company.",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID this contact belongs to"),
      first_name: z.string().describe("Contact's first name"),
      last_name: z.string().describe("Contact's last name"),
      email: z.string().email().optional().describe("Email address"),
      phone: z.string().optional().describe("Phone number"),
      role: z
        .string()
        .optional()
        .describe("Role at the organization, e.g. 'CEO', 'CTO', 'Head of Sales'"),
      is_primary: z
        .boolean()
        .default(false)
        .describe("Whether this is the primary contact for the organization"),
    }),
    handler: async (ctx: ToolContext, params: {
      customer_id: string;
      first_name: string;
      last_name: string;
      email?: string;
      phone?: string;
      role?: string;
      is_primary?: boolean;
    }) => {
      if (params.is_primary) {
        await ctx.db
          .from("contacts")
          .update({ is_primary: false })
          .eq("customer_id", params.customer_id)
          .eq("company_id", ctx.companyId)
          .eq("is_primary", true);
      }

      const { data, error } = await ctx.db
        .from("contacts")
        .insert({
          company_id: ctx.companyId,
          customer_id: params.customer_id,
          first_name: params.first_name,
          last_name: params.last_name,
          email: params.email || null,
          phone: params.phone || null,
          role: params.role || null,
          is_primary: params.is_primary || false,
        })
        .select()
        .single();

      if (error) throw new Error(`Failed to add contact: ${error.message}`);
      return { success: true, contact: data };
    },
  },

  update_contact: {
    title: "Update Contact",
    description: "Update a contact's details.",
    parameters: z.object({
      contact_id: z.string().uuid().describe("Contact UUID"),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      role: z.string().optional(),
      is_primary: z.boolean().optional(),
    }),
    handler: async (ctx: ToolContext, params: { contact_id: string; [key: string]: unknown }) => {
      const { contact_id, ...updates } = params;

      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );

      if (Object.keys(cleanUpdates).length === 0) {
        return { success: true, message: "No fields to update" };
      }

      if (cleanUpdates.is_primary === true) {
        const { data: contact } = await ctx.db
          .from("contacts")
          .select("customer_id")
          .eq("id", contact_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();

        if (contact) {
          await ctx.db
            .from("contacts")
            .update({ is_primary: false })
            .eq("customer_id", contact.customer_id)
            .eq("company_id", ctx.companyId)
            .eq("is_primary", true);
        }
      }

      const { data, error } = await ctx.db
        .from("contacts")
        .update(cleanUpdates)
        .eq("id", contact_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();

      if (error) throw new Error(`Failed to update contact: ${error.message}`);
      return { success: true, contact: data };
    },
  },

  search_contacts: {
    title: "Search Contacts",
    description:
      "Search for contacts by name, email, phone, or role. Returns matching contacts with their customer/organization info. Use this when someone asks about a person by name.",
    parameters: z.object({
      query: z.string().describe("Search text (searches first name, last name, email, phone, role)"),
      limit: z.number().min(1).max(50).default(10).describe("Max results to return"),
    }),
    handler: async (ctx: ToolContext, params: { query: string; limit?: number }) => {
      // Sanitize before interpolating into PostgREST filter strings
      const q = sanitizeSearchQuery(params.query.trim());
      const limit = params.limit || 10;
      const parts = q.split(/\s+/).filter(Boolean);

      const filters = [
        `first_name.ilike.%${q}%`,
        `last_name.ilike.%${q}%`,
        `email.ilike.%${q}%`,
        `phone.ilike.%${q}%`,
        `role.ilike.%${q}%`,
      ];

      if (parts.length >= 2) {
        for (const part of parts) {
          filters.push(`first_name.ilike.%${part}%`);
          filters.push(`last_name.ilike.%${part}%`);
        }
      }

      const { data, error } = await ctx.db
        .from("contacts")
        .select("*, customers(id, organization_name, customer_type, customer_phase, city, state, tags)")
        .eq("company_id", ctx.companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .is("customers.deleted_at", null)
        .or(filters.join(","))
        .order("last_name")
        .limit(limit);

      if (error) throw new Error(`Search failed: ${error.message}`);

      const results = (data || []).map((c) => ({
        contact: {
          id: c.id,
          name: `${c.first_name} ${c.last_name}`,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          phone: c.phone,
          role: c.role,
          is_primary: c.is_primary,
        },
        organization: c.customers,
      }));

      return { results, count: results.length };
    },
  },

  remove_contact: {
    title: "Remove Contact",
    description:
      "Remove a contact by archiving (marks as inactive, recoverable) or permanently deleting. " +
      "On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. Interaction history referencing this contact is preserved on archive.",
    parameters: z.object({
      contact_id: z.string().uuid().describe("Contact UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, params: { contact_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      const { contact_id, mode, resolution } = params;

      // Fetch contact with customer info for label and scope
      const { data: contact, error: fetchErr } = await ctx.db
        .from("contacts")
        .select("id, first_name, last_name, customer_id, is_active, customers(company_id)")
        .eq("id", contact_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Contact not found: ${fetchErr.message}`);

      const contactName = `${contact.first_name} ${contact.last_name}`;

      return handleRemove({
        ctx,
        entity_type: "contact",
        entity_id: contact_id,
        entity_label: contactName,
        scope: "org",
        company_id: ctx.companyId,
        mode,
        resolution,
        delete_warning: "Interaction history referencing this contact will lose its contact link.",
        before_state: {
          first_name: contact.first_name,
          last_name: contact.last_name,
          is_active: contact.is_active,
          customer_id: contact.customer_id,
        },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("contacts")
            .update({ is_active: false })
            .eq("id", contact_id)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive contact: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          const { data, error } = await ctx.db
            .from("contacts")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", contact_id)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete contact: ${error.message}`);
          return data;
        },
      });
    },
  },
};
