import { z } from "zod";
import { detectFirstRun, FIRST_RUN_HINT } from "../first-run.js";
import { sanitizeSearchQuery } from "../../utils/sanitize.js";
import { conflict } from "../conflict.js";
import { writeAuditLog } from "../audit.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import { tagFilterParams, resolveTagList } from "../filters.js";
import { cascadeTriggersForEntity } from "../triggers/cleanup.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

// ────────────────────────────────────────
// Customer tools (schema + handler pairs)
// ────────────────────────────────────────

export const customerTools = {
  add_customer: {
    title: "Add Customer",
    description:
      "Create a new customer record. Customers are organizations or individuals that your business works with or is pursuing. " +
      "If similar customers already exist, a `conflict` response is returned with options to use an existing record " +
      "or create a new one. Pass skip_duplicate_check=true to bypass this on retry.",
    parameters: z.object({
      organization_name: z.string().describe("Name of the company, organization, or individual"),
      customer_type: z
        .enum(["client", "partner", "vendor", "investor", "other"])
        .default("other")
        .describe("Type of customer"),
      customer_phase: z
        .enum(["prospect", "lead", "opportunity", "customer", "renewal", "churned", "inactive"])
        .default("prospect")
        .describe("Lifecycle phase: prospect, lead, opportunity, customer, renewal, churned, or inactive"),
      address_line1: z.string().optional().describe("Street address"),
      address_line2: z.string().optional().describe("Suite, building, etc."),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("2-letter state code"),
      zip: z.string().optional().describe("ZIP code"),
      website: z.string().optional().describe("Website URL"),
      notes: z.string().optional().describe("General notes about this customer"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for categorization, e.g. ['saas', 'enterprise']"),
      skip_duplicate_check: z
        .boolean()
        .optional()
        .describe("Set true after conflict resolution to skip duplicate detection and create the customer."),
    }),
    // First contextual handler. Receives ToolContext from
    // registerCRMTools (built once in src/index.ts via buildContext).
    // No createServiceClient() or getCompanyId() calls in this body;
    // the tool-context-lint test enforces that for files in the
    // CONTEXTUAL_FILES allowlist.
    handler: async (ctx: ToolContext, params: {
      organization_name: string;
      customer_type?: string;
      customer_phase?: string;
      address_line1?: string;
      address_line2?: string;
      city?: string;
      state?: string;
      zip?: string;
      website?: string;
      notes?: string;
      tags?: string[];
      skip_duplicate_check?: boolean;
    }) => {
      // Duplicate detection: search for similar existing customers
      if (!params.skip_duplicate_check) {
        const safeName = sanitizeSearchQuery(params.organization_name);
        const { data: matches } = await ctx.db
          .from("customers")
          .select("id, organization_name, customer_type, customer_phase, city, state")
          .eq("company_id", ctx.companyId)
          .ilike("organization_name", `%${safeName}%`)
          .is("deleted_at", null)
          .limit(5);

        if (matches && matches.length > 0) {
          return conflict(
            "partial_match",
            "Similar customers already exist. Did you mean one of these, or is this a new customer?",
            [
              ...matches.map((m: {
                id: string;
                organization_name: string;
                customer_phase: string;
                city: string | null;
                state: string | null;
              }) => ({
                key: `existing_${m.id}`,
                label: `Use existing: ${m.organization_name} (${m.customer_phase}${m.city ? `, ${m.city}` : ""}${m.state ? ` ${m.state}` : ""})`,
                value: { customer_id: m.id },
              })),
              {
                key: "create_new",
                label: `Create new: "${params.organization_name}"`,
                value: { skip_duplicate_check: true },
              },
            ],
            { similar_customers: matches }
          );
        }
      }

      const { data, error } = await ctx.db
        .from("customers")
        .insert({
          company_id: ctx.companyId,
          organization_name: params.organization_name,
          customer_type: params.customer_type || "other",
          customer_phase: params.customer_phase || "prospect",
          address_line1: params.address_line1 || null,
          address_line2: params.address_line2 || null,
          city: params.city || null,
          state: params.state || null,
          zip: params.zip || null,
          website: params.website || null,
          notes: params.notes || null,
          tags: params.tags || [],
        })
        .select()
        .single();

      if (error) throw new Error(`Failed to create customer: ${error.message}`);

      const result: Record<string, unknown> = { success: true, customer: data };

      // Surface which defaults were applied so the AI can mention them conversationally
      const defaultsApplied: Record<string, string> = {};
      if (!params.customer_type) defaultsApplied.customer_type = "other";
      if (!params.customer_phase) defaultsApplied.customer_phase = "prospect";
      if (Object.keys(defaultsApplied).length > 0) {
        result.defaults_applied = defaultsApplied;
      }

      if (await detectFirstRun(ctx.db, ctx.companyId)) {
        result._hint =
          "Great - the user just created their first customer! This is a fresh install. " +
          "Consider suggesting they create a task linked to this customer next, " +
          "or ask if they'd like to explore other features with show_capabilities.";
      }

      return result;
    },
  },

  get_customer: {
    title: "Get Customer",
    description:
      "Get a single customer with their contacts, recent interactions, and open tasks.",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID"),
    }),
    handler: async (ctx: ToolContext, params: { customer_id: string }) => {
      const [customerRes, contactsRes, interactionsRes, openTasksRes] = await Promise.all([
        ctx.db.from("customers").select("*").eq("id", params.customer_id).eq("company_id", ctx.companyId).is("deleted_at", null).single(),
        ctx.db
          .from("contacts")
          .select("*")
          .eq("customer_id", params.customer_id)
          .eq("company_id", ctx.companyId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .order("is_primary", { ascending: false }),
        ctx.db
          .from("interactions")
          .select("*")
          .eq("customer_id", params.customer_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .order("interaction_date", { ascending: false })
          .limit(20),
        ctx.db
          .from("task_links")
          .select("tasks(*)")
          .eq("entity_type", "customer")
          .eq("entity_id", params.customer_id)
          .eq("company_id", ctx.companyId)
          .in("tasks.status", ["todo", "in_progress", "blocked"])
          .is("tasks.deleted_at", null)
          .order("tasks(due_date)", { ascending: true }),
      ]);

      if (customerRes.error) throw new Error(`Customer not found: ${customerRes.error.message}`);

      const openTasks = (openTasksRes.data || [])
        .map((row: { tasks: unknown }) => row.tasks)
        .filter(Boolean);

      return {
        customer: customerRes.data,
        contacts: contactsRes.data || [],
        recent_interactions: interactionsRes.data || [],
        open_tasks: openTasks,
      };
    },
  },

  update_customer: {
    title: "Update Customer",
    description: "Update fields on an existing customer record.",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID"),
      organization_name: z.string().optional(),
      customer_type: z.enum(["client", "partner", "vendor", "investor", "other"]).optional(),
      customer_phase: z
        .enum(["prospect", "lead", "opportunity", "customer", "renewal", "churned", "inactive"])
        .optional()
        .describe("Lifecycle phase"),
      address_line1: z.string().optional(),
      address_line2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      website: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    handler: async (ctx: ToolContext, params: { customer_id: string; [key: string]: unknown }) => {
      const { customer_id, ...updates } = params;

      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([, v]) => v !== undefined)
      );

      if (Object.keys(cleanUpdates).length === 0) {
        return { success: true, message: "No fields to update" };
      }

      const { data, error } = await ctx.db
        .from("customers")
        .update(cleanUpdates)
        .eq("id", customer_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();

      if (error) throw new Error(`Failed to update customer: ${error.message}`);
      return { success: true, customer: data };
    },
  },

  search_customers: {
    title: "Search Customers",
    description:
      "Search customers by name, notes, city, state, or tags. Returns matching customers with summary info.",
    parameters: z.object({
      query: z.string().describe("Search text (searches organization name, notes, city, state)"),
      customer_type: z
        .enum(["client", "partner", "vendor", "investor", "other"])
        .optional()
        .describe("Filter by customer type"),
      customer_phase: z
        .enum(["prospect", "lead", "opportunity", "customer", "renewal", "churned", "inactive"])
        .optional()
        .describe("Filter by lifecycle phase"),
      ...tagFilterParams,
      limit: z.number().min(1).max(100).default(25).describe("Max results to return"),
    }),
    handler: async (ctx: ToolContext, params: { query: string; customer_type?: string; customer_phase?: string; tag?: string; tags?: string[]; tag_match?: "all" | "any"; limit?: number }) => {
      // Sanitize before any interpolation into PostgREST filter strings
      const safeQuery = sanitizeSearchQuery(params.query);

      let searchStrategy: "fts" | "ilike_fallback" = "fts";
      let phaseFilterApplied = false;

      let q = ctx.db
        .from("customer_summary")
        .select("*")
        .eq("company_id", ctx.companyId)
        .textSearch(
          "organization_name",
          safeQuery.split(/\s+/).filter(Boolean).join(" & "),
          { type: "websearch" }
        )
        .limit(params.limit || 25);

      // Note: customer_phase filter is only applied on the ILIKE fallback path,
      // not on the FTS path. This is a known limitation surfaced via search_metadata.
      const { data: ftsData, error: ftsError } = await q;

      let results = ftsData;
      if (ftsError || !ftsData?.length) {
        searchStrategy = "ilike_fallback";

        let fallback = ctx.db
          .from("customer_summary")
          .select("*")
          .eq("company_id", ctx.companyId)
          .or(
            `organization_name.ilike.%${safeQuery}%,city.ilike.%${safeQuery}%,state.ilike.%${safeQuery}%`
          )
          .limit(params.limit || 25);

        if (params.customer_type) {
          fallback = fallback.eq("customer_type", params.customer_type);
        }
        if (params.customer_phase) {
          fallback = fallback.eq("customer_phase", params.customer_phase);
          phaseFilterApplied = true;
        }
        const tagList = resolveTagList(params.tag, params.tags);
        if (tagList) {
          fallback = params.tag_match === "any"
            ? fallback.overlaps("tags", tagList)
            : fallback.contains("tags", tagList);
        }

        const { data, error } = await fallback;
        if (error) throw new Error(`Search failed: ${error.message}`);
        results = data;
      }

      const response: Record<string, unknown> = {
        results: results || [],
        count: results?.length || 0,
        search_metadata: {
          search_strategy: searchStrategy,
          phase_filter_applied: phaseFilterApplied,
          ...(searchStrategy === "fts" && params.customer_phase
            ? { note: "customer_phase filter is not applied during full-text search, only on ILIKE fallback." }
            : {}),
        },
      };

      if (await detectFirstRun(ctx.db, ctx.companyId)) {
        response._hint = FIRST_RUN_HINT;
      }

      return response;
    },
  },

  list_customers: {
    title: "List Customers",
    description:
      "List customers with optional filters. Returns paginated results with summary info. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      customer_type: z
        .enum(["client", "partner", "vendor", "investor", "other"])
        .optional()
        .describe("Filter by customer type"),
      customer_phase: z
        .enum(["prospect", "lead", "opportunity", "customer", "renewal", "churned", "inactive"])
        .optional()
        .describe("Filter by lifecycle phase"),
      ...tagFilterParams,
      state: z.string().optional().describe("Filter by 2-letter state code"),
      has_open_follow_ups: z
        .boolean()
        .optional()
        .describe("If true, only return customers with open tasks"),
      limit: z.number().min(1).max(100).default(50).describe("Max results"),
      offset: z.number().min(0).default(0).describe("Offset for pagination"),
    }),
    handler: async (ctx: ToolContext, params: {
      customer_type?: string;
      customer_phase?: string;
      tag?: string;
      tags?: string[];
      tag_match?: "all" | "any";
      state?: string;
      has_open_follow_ups?: boolean;
      limit?: number;
      offset?: number;
    }) => {
      const limit = params.limit || 50;
      const offset = params.offset || 0;

      let query = ctx.db
        .from("customer_summary")
        .select("*", { count: "exact" })
        .eq("company_id", ctx.companyId)
        .order("organization_name")
        .range(offset, offset + limit - 1);

      if (params.customer_type) {
        query = query.eq("customer_type", params.customer_type);
      }
      if (params.customer_phase) {
        query = query.eq("customer_phase", params.customer_phase);
      } else {
        // By default, hide archived (inactive) customers
        query = query.neq("customer_phase", "inactive");
      }
      const tagList = resolveTagList(params.tag, params.tags);
      if (tagList) {
        query = params.tag_match === "any"
          ? query.overlaps("tags", tagList)
          : query.contains("tags", tagList);
      }
      if (params.state) {
        query = query.eq("state", params.state);
      }
      if (params.has_open_follow_ups) {
        query = query.gt("open_tasks", 0);
      }

      const { data, error, count } = await query;
      if (error) throw new Error(`Failed to list customers: ${error.message}`);

      // Build tier_3 markdown fallback
      const custRows = (data || []) as {
        organization_name: string;
        customer_type: string;
        customer_phase: string;
        open_tasks: number;
        state: string | null;
      }[];
      const custTable =
        `| Organization | Type | Phase | Open Tasks | State |\n` +
        `|-------------|------|-------|------------|-------|\n` +
        custRows
          .slice(0, 20)
          .map(
            (c) =>
              `| ${c.organization_name} | ${c.customer_type} | ${c.customer_phase} | ${c.open_tasks ?? 0} | ${c.state ?? "-"} |`
          )
          .join("\n") +
        (custRows.length > 20 ? `\n\n_Showing 20 of ${count ?? custRows.length} customers_` : "") +
        ((count ?? 0) > limit ? `\n\n_Page ${Math.floor(offset / limit) + 1} of ${Math.ceil((count ?? 0) / limit)}_` : "");

      const result: Record<string, unknown> = {
        customers: data || [],
        total: count || 0,
        limit,
        offset,
        render: {
          tier_1: {
            format_hint: "table",
            instructions: {
              scope:
                "render the `customers` array with columns: organization_name, " +
                "customer_type, customer_phase, open_tasks, state. Cap visible " +
                "rows at 20; show total count separately.",
              format:
                "phase badges and a numeric chip for open_tasks. Apply the " +
                "standard color conventions (amber chip when open_tasks > 0, " +
                "neutral when 0).",
              forbidden:
                "do not omit the open_tasks column (it drives follow-up actions); " +
                "do not display more than 20 rows by default.",
            },
          },
          tier_3: {
            markdown: custTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
            "For 2 or fewer rows, inline rendering is fine.",
          ],
        } satisfies Render,
      };

      if (await detectFirstRun(ctx.db, ctx.companyId)) {
        result._hint = FIRST_RUN_HINT;
      }

      return result;
    },
  },

  remove_customer: {
    title: "Remove Customer",
    description:
      "Remove a customer by archiving (sets phase to inactive, recoverable) or permanently deleting. " +
      "On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. Contacts cascade on delete; history is preserved on archive.",
    parameters: z.object({
      customer_id: z.string().uuid().describe("Customer UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, params: { customer_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      const { customer_id, mode, resolution } = params;

      // Fetch customer
      const { data: customer, error: fetchErr } = await ctx.db
        .from("customers")
        .select("id, organization_name, customer_phase, company_id")
        .eq("id", customer_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Customer not found: ${fetchErr.message}`);

      // Gather linked data counts for the conflict message
      const [contactsRes, tasksRes, interactionsRes] = await Promise.all([
        ctx.db
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("customer_id", customer_id)
          .eq("company_id", ctx.companyId)
          .eq("is_active", true)
          .is("deleted_at", null),
        ctx.db
          .from("task_links")
          .select("task_id", { count: "exact", head: true })
          .eq("entity_type", "customer")
          .eq("entity_id", customer_id)
          .eq("company_id", ctx.companyId),
        ctx.db
          .from("interactions")
          .select("id", { count: "exact", head: true })
          .eq("customer_id", customer_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null),
      ]);

      const linked_data: Record<string, number> = {};
      if ((contactsRes.count ?? 0) > 0) linked_data["active contact(s)"] = contactsRes.count!;
      if ((tasksRes.count ?? 0) > 0) linked_data["linked task(s)"] = tasksRes.count!;
      if ((interactionsRes.count ?? 0) > 0) linked_data["interaction(s)"] = interactionsRes.count!;

      return handleRemove({
        ctx,
        entity_type: "customer",
        entity_id: customer_id,
        entity_label: customer.organization_name,
        scope: "org",
        company_id: customer.company_id,
        mode,
        resolution,
        linked_data,
        delete_warning: "All contacts and interaction history will be permanently deleted.",
        before_state: {
          organization_name: customer.organization_name,
          customer_phase: customer.customer_phase,
        },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("customers")
            .update({ customer_phase: "inactive" })
            .eq("id", customer_id)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive customer: ${error.message}`);
          // An inactive customer should not keep firing its watchers.
          await cascadeTriggersForEntity(ctx, "customer", customer_id);
          return data;
        },
        deleteFn: async () => {
          // Soft-delete the customer AND cascade to its children so they
          // don't orphan during the 30-day recovery window. (FK ON DELETE
          // CASCADE only fires on the eventual hard purge, not on soft-delete.)
          const deletedAt = new Date().toISOString();

          const { data, error } = await ctx.db
            .from("customers")
            .update({ deleted_at: deletedAt })
            .eq("id", customer_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete customer: ${error.message}`);

          // Cascade: soft-delete still-live contacts and interactions.
          const [contactsErr, interactionsErr] = await Promise.all([
            ctx.db
              .from("contacts")
              .update({ deleted_at: deletedAt })
              .eq("customer_id", customer_id)
              .eq("company_id", ctx.companyId)
              .is("deleted_at", null)
              .then((r) => r.error),
            ctx.db
              .from("interactions")
              .update({ deleted_at: deletedAt })
              .eq("customer_id", customer_id)
              .eq("company_id", ctx.companyId)
              .is("deleted_at", null)
              .then((r) => r.error),
          ]);

          if (contactsErr) {
            throw new Error(`Customer deleted but contact cascade failed: ${contactsErr.message}`);
          }
          if (interactionsErr) {
            throw new Error(`Customer deleted but interaction cascade failed: ${interactionsErr.message}`);
          }

          // Cascade: soft-delete watchers bound to this customer so a
          // removed customer leaves no enabled trigger behind.
          await cascadeTriggersForEntity(ctx, "customer", customer_id);

          return data;
        },
      });
    },
  },
};
