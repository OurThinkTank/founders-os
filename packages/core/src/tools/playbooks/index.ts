// ============================================================
// Founders OS — Playbooks Tools (v0.7.0)
// ============================================================
// Repeatable orchestration templates. A playbook defines an
// ordered list of steps — either native_task (created in
// Founders OS) or external_action (instructions the AI
// executes via connected MCP tools like GitHub or Slack).
//
// run_playbook resolves {{placeholders}} from customer context,
// creates native tasks, and returns external actions for the
// AI to dispatch. Founders OS is the orchestration layer;
// the AI is the executor for external actions.
//
// Connector availability: Founders OS cannot directly query
// which MCP tools are connected to the client session. Use
// preflight_only: true on run_playbook to inspect requirements
// before executing. At runtime, if a connector is unavailable,
// create a fallback native task using the step's fallback_task.
//
// Placeholder syntax (all text fields):
//   {{customer.name}}           organization_name
//   {{customer.slug}}           lowercased, hyphenated org name
//   {{contact.primary.name}}    primary contact full name
//   {{contact.primary.email}}   primary contact email
//   {{playbook.start_date}}     YYYY-MM-DD anchor date
//   {{playbook.start_date+Nd}}  anchor date plus N days
//   {{playbook.start_year}}     4-digit year from start_date
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { writeAuditLog } from "../audit.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import { cascadeTriggersForEntity } from "../triggers/cleanup.js";
import type { ToolContext } from "../../types/context.js";

// Note: helpers used inside contextual handlers below are all contextual:
//   - writeAuditLog(ctx, ...) (audit.ts refactor 2026-05-28)
//   - handleRemove() reads opts.ctx for permissions + audit
//   - The lint forbids createServiceClient/getCompanyId/getUserId tokens
//     directly inside contextual handler bodies; indirect helpers are fine.

// ── Placeholder resolution ────────────────────────────────

interface PlaceholderContext {
  customerName: string;
  customerSlug: string;
  primaryContactName: string;
  primaryContactEmail: string;
  startDate: string;         // YYYY-MM-DD
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolvePlaceholders(
  template: string,
  ctx: PlaceholderContext
): string {
  return template
    .replace(/\{\{customer\.name\}\}/g, ctx.customerName)
    .replace(/\{\{customer\.slug\}\}/g, ctx.customerSlug)
    .replace(/\{\{contact\.primary\.name\}\}/g, ctx.primaryContactName)
    .replace(/\{\{contact\.primary\.email\}\}/g, ctx.primaryContactEmail)
    .replace(/\{\{playbook\.start_date\}\}/g, ctx.startDate)
    .replace(/\{\{playbook\.start_year\}\}/g, ctx.startDate.slice(0, 4))
    .replace(/\{\{playbook\.start_date\+(\d+)d\}\}/g, (_, n: string) =>
      addDays(ctx.startDate, parseInt(n, 10))
    );
}

function resolveJsonPlaceholders(
  obj: unknown,
  ctx: PlaceholderContext
): unknown {
  if (typeof obj === "string") return resolvePlaceholders(obj, ctx);
  if (Array.isArray(obj)) return obj.map((v) => resolveJsonPlaceholders(v, ctx));
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveJsonPlaceholders(v, ctx);
    }
    return out;
  }
  return obj;
}

// ── Types ─────────────────────────────────────────────────

interface PlaybookRow {
  id: string;
  company_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface PlaybookStepRow {
  id: string;
  playbook_id: string;
  order_index: number;
  type: "native_task" | "external_action";
  title: string;
  description: string | null;
  assignee: string | null;
  due_offset: number | null;
  priority: string;
  connector: string | null;
  action: string | null;
  params: Record<string, unknown> | null;
  fallback_task: string | null;
  created_at: string;
}

interface ContactRow {
  first_name: string;
  last_name: string;
  email: string | null;
}

interface CustomerRow {
  id: string;
  organization_name: string;
}

// ── Shared helpers ────────────────────────────────────────

/** Resolve a playbook by UUID or slug, scoped to this company. */
async function resolvePlaybook(
  supabase: SupabaseClient,
  playbookId: string,
  companyId: string
): Promise<PlaybookRow> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    playbookId
  );
  const q = supabase.from("playbooks").select("*").eq("company_id", companyId).is("deleted_at", null);
  const { data, error } = isUuid
    ? await q.eq("id", playbookId).single()
    : await q.eq("slug", playbookId).single();
  if (error || !data)
    throw new Error(`Playbook not found: ${error?.message ?? "no match"}`);
  return data as PlaybookRow;
}

/** Fetch steps for a playbook ordered by order_index. */
async function loadSteps(
  supabase: SupabaseClient,
  playbookId: string
): Promise<PlaybookStepRow[]> {
  const { data, error } = await supabase
    .from("playbook_steps")
    .select("*")
    .eq("playbook_id", playbookId)
    .or("archived.is.null,archived.eq.false")
    .is("deleted_at", null)
    .order("order_index", { ascending: true });
  if (error) throw new Error(`Failed to load steps: ${error.message}`);
  return (data ?? []) as PlaybookStepRow[];
}

/** Summarise which external connectors are required by a step list. */
function buildConnectorRequirements(
  steps: PlaybookStepRow[]
): {
  connectors: string[];
  breakdown: { connector: string; action: string; step_title: string }[];
} {
  const seen = new Set<string>();
  const breakdown: { connector: string; action: string; step_title: string }[] = [];
  for (const s of steps) {
    if (s.type === "external_action" && s.connector) {
      seen.add(s.connector);
      breakdown.push({
        connector: s.connector,
        action: s.action ?? "unknown",
        step_title: s.title,
      });
    }
  }
  return { connectors: Array.from(seen), breakdown };
}

// ── Tool map ──────────────────────────────────────────────

export const playbookTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // create_playbook
  // ──────────────────────────────────────────────────────────
  create_playbook: {
    title: "Create Playbook",
    description:
      "Create a new reusable playbook template. A playbook is an ordered set of steps " +
      "run against a customer to automate project setup. Add steps with add_playbook_step after creation.",
    parameters: z.object({
      name: z.string().describe("Human-readable name, e.g. 'New Web Project'."),
      slug: z
        .string()
        .describe(
          "URL-safe unique identifier, e.g. 'new-web-project'. Must be unique per company."
        ),
      description: z
        .string()
        .optional()
        .describe("What this playbook is for and when to use it."),
    }),
    handler: async (ctx: ToolContext, {
      name,
      slug,
      description,
    }: {
      name: string;
      slug: string;
      description?: string;
    }) => {
      const supabase = ctx.db;
      const { data, error } = await supabase
        .from("playbooks")
        .insert({
          company_id: ctx.companyId,
          name,
          slug,
          description: description ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(`Failed to create playbook: ${error.message}`);
      return { success: true, playbook: data as PlaybookRow };
    },
  },

  // ──────────────────────────────────────────────────────────
  // update_playbook
  // ──────────────────────────────────────────────────────────
  update_playbook: {
    title: "Update Playbook",
    description:
      "Update a playbook's name, slug, or description. Only provided fields are changed. " +
      "Steps are not affected — use update_playbook_step for those.",
    parameters: z.object({
      playbook_id: z
        .string()
        .describe("Playbook UUID or slug."),
      name: z.string().optional().describe("New human-readable name."),
      slug: z
        .string()
        .optional()
        .describe("New slug. Must be unique per company."),
      description: z.string().optional().describe("New description."),
    }),
    handler: async (ctx: ToolContext, {
      playbook_id,
      name,
      slug,
      description,
    }: {
      playbook_id: string;
      name?: string;
      slug?: string;
      description?: string;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const pb = await resolvePlaybook(supabase, playbook_id, companyId);

      const updates: Record<string, unknown> = {};
      if (name !== undefined) updates.name = name;
      if (slug !== undefined) updates.slug = slug;
      if (description !== undefined) updates.description = description;

      if (Object.keys(updates).length === 0) {
        return { success: true, message: "No fields to update.", playbook: pb };
      }

      const { data, error } = await supabase
        .from("playbooks")
        .update(updates)
        .eq("id", pb.id)
        .select()
        .single();
      if (error) throw new Error(`Failed to update playbook: ${error.message}`);
      return { success: true, playbook: data as PlaybookRow };
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_playbook
  // ──────────────────────────────────────────────────────────
  remove_playbook: {
    title: "Remove Playbook",
    description:
      "Remove a playbook by archiving (hides from active views, recoverable) or permanently deleting. " +
      "On first call, returns a conflict with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. Run history is preserved in both cases. " +
      "Tasks already created by previous runs are not affected.",
    parameters: z.object({
      playbook_id: z.string().describe("Playbook UUID or slug."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, {
      playbook_id,
      mode,
      resolution,
    }: {
      playbook_id: string;
      mode?: RemoveMode;
      resolution?: RemoveResolution;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const pb = await resolvePlaybook(supabase, playbook_id, companyId);

      // Count linked data
      const [stepsRes, runsRes] = await Promise.all([
        supabase
          .from("playbook_steps")
          .select("id", { count: "exact", head: true })
          .eq("playbook_id", pb.id)
          .is("deleted_at", null),
        supabase
          .from("playbook_runs")
          .select("id", { count: "exact", head: true })
          .eq("playbook_id", pb.id),
      ]);

      return handleRemove({
        ctx,
        entity_type: "playbook",
        entity_id: pb.id,
        entity_label: pb.name,
        scope: "org",
        company_id: companyId,
        mode,
        resolution,
        linked_data: {
          steps: stepsRes.count ?? 0,
          runs: runsRes.count ?? 0,
        },
        delete_warning: "All steps will be permanently deleted. Run history references will be unlinked.",
        before_state: {
          name: pb.name,
          slug: pb.slug,
          description: pb.description,
        },
        archiveFn: async () => {
          const { data, error } = await supabase
            .from("playbooks")
            .update({ archived: true })
            .eq("id", pb.id)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive playbook: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          // Soft-delete the playbook and its steps
          const now = new Date().toISOString();
          await supabase
            .from("playbook_steps")
            .update({ deleted_at: now })
            .eq("playbook_id", pb.id);

          const { data, error } = await supabase
            .from("playbooks")
            .update({ deleted_at: now })
            .eq("id", pb.id)
            .eq("company_id", companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete playbook: ${error.message}`);
          return data;
        },
      });
    },
  },

  // ──────────────────────────────────────────────────────────
  // add_playbook_step
  // ──────────────────────────────────────────────────────────
  add_playbook_step: {
    title: "Add Playbook Step",
    description:
      "Add an ordered step to a playbook. Steps are either 'native_task' (created in Founders OS " +
      "when the playbook runs) or 'external_action' (instructions returned for the AI to execute " +
      "via connected MCP tools like GitHub or Slack). All text fields support {{placeholder}} syntax. " +
      "Steps are ordered by order_index; append by using a value higher than existing steps.",
    parameters: z.object({
      playbook_id: z.string().uuid().describe("Playbook UUID."),
      order_index: z
        .number()
        .int()
        .describe("Position in the step sequence. Lower numbers run first."),
      type: z
        .enum(["native_task", "external_action"])
        .describe(
          "'native_task' creates a task in Founders OS. 'external_action' emits instructions for the AI to execute."
        ),
      title: z
        .string()
        .describe("Step title. Supports {{placeholders}} like {{customer.name}}."),
      description: z
        .string()
        .optional()
        .describe("Additional context. Supports {{placeholders}}."),

      // native_task fields
      assigned_to: z
        .string()
        .optional()
        .describe(
          "For native_task: who to assign to. Use FOUNDERS_OS_USER_ID, '@claude', or '@gpt'."
        ),
      assignee: z
        .string()
        .optional()
        .describe("Deprecated: use `assigned_to`."),
      due_offset: z
        .number()
        .int()
        .optional()
        .describe(
          "For native_task: due date offset in days from the playbook start_date. Omit for no due date."
        ),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("For native_task: priority. Defaults to 'medium'."),

      // external_action fields
      connector: z
        .string()
        .optional()
        .describe(
          "For external_action: the MCP connector to use, e.g. 'github', 'slack', 'calendar'."
        ),
      action: z
        .string()
        .optional()
        .describe(
          "For external_action: the action to perform, e.g. 'create_repo', 'create_channel'."
        ),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "For external_action: connector-specific parameters. Supports {{placeholders}}. " +
          "Example: { template: 'ourthinktank/web-template', name: '{{customer.slug}}-{{playbook.start_year}}' }"
        ),
      fallback_task: z
        .string()
        .optional()
        .describe(
          "For external_action: task title to create if the connector is unavailable at run time. " +
          "Always provide this so the playbook degrades gracefully."
        ),
    }),
    handler: async (ctx: ToolContext, rawParams: {
      playbook_id: string;
      order_index: number;
      type: "native_task" | "external_action";
      title: string;
      description?: string;
      assigned_to?: string;
      assignee?: string;
      due_offset?: number;
      priority?: "low" | "medium" | "high" | "urgent";
      connector?: string;
      action?: string;
      params?: Record<string, unknown>;
      fallback_task?: string;
    }) => {
      const supabase = ctx.db;

      // Verify playbook belongs to this company
      const { data: pb, error: pbErr } = await supabase
        .from("playbooks")
        .select("id")
        .eq("id", rawParams.playbook_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();
      if (pbErr || !pb) throw new Error("Playbook not found or access denied.");

      const { data, error } = await supabase
        .from("playbook_steps")
        .insert({
          playbook_id: rawParams.playbook_id,
          order_index: rawParams.order_index,
          type: rawParams.type,
          title: rawParams.title,
          description: rawParams.description ?? null,
          assignee: rawParams.assigned_to ?? rawParams.assignee ?? null,
          due_offset: rawParams.due_offset ?? null,
          priority: rawParams.priority ?? "medium",
          connector: rawParams.connector ?? null,
          action: rawParams.action ?? null,
          params: rawParams.params ?? null,
          fallback_task: rawParams.fallback_task ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(`Failed to add step: ${error.message}`);
      return { success: true, step: data as PlaybookStepRow };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_playbooks
  // ──────────────────────────────────────────────────────────
  list_playbooks: {
    title: "List Playbooks",
    description:
      "List all defined playbooks for this company. Returns name, slug, description, and step count. " +
      "Archived playbooks are hidden by default.",
    parameters: z.object({
      include_archived: z
        .boolean()
        .optional()
        .describe("Set true to include archived playbooks. Defaults to false."),
    }),
    handler: async (ctx: ToolContext, params: { include_archived?: boolean }) => {
      const supabase = ctx.db;
      let query = supabase
        .from("playbooks")
        .select("*")
        .eq("company_id", ctx.companyId)
        .order("name", { ascending: true });

      if (!params.include_archived) {
        query = query.or("archived.is.null,archived.eq.false");
      }
      query = query.is("deleted_at", null);

      const { data: playbooks, error } = await query;
      if (error) throw new Error(`Failed to list playbooks: ${error.message}`);

      if (!playbooks || playbooks.length === 0) {
        return {
          playbooks: [],
          count: 0,
          hint: "No playbooks yet. Create one with create_playbook, then add steps with add_playbook_step.",
        };
      }

      // Fetch step counts for all playbooks in one query
      const ids = (playbooks as PlaybookRow[]).map((p) => p.id);
      const { data: stepRows } = await supabase
        .from("playbook_steps")
        .select("playbook_id")
        .in("playbook_id", ids)
        .is("deleted_at", null);

      const countMap: Record<string, number> = {};
      for (const row of stepRows ?? []) {
        const r = row as { playbook_id: string };
        countMap[r.playbook_id] = (countMap[r.playbook_id] ?? 0) + 1;
      }

      const enriched = (playbooks as PlaybookRow[]).map((p) => ({
        ...p,
        step_count: countMap[p.id] ?? 0,
      }));

      return { playbooks: enriched, count: enriched.length };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_playbook
  // ──────────────────────────────────────────────────────────
  get_playbook: {
    title: "Get Playbook",
    description:
      "Fetch a single playbook with its full ordered step list and connector requirements. " +
      "Use before running to inspect what the playbook will do and which connectors it needs.",
    parameters: z.object({
      playbook_id: z
        .string()
        .describe("Playbook UUID or slug."),
    }),
    handler: async (ctx: ToolContext, { playbook_id }: { playbook_id: string }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const playbook = await resolvePlaybook(supabase, playbook_id, companyId);
      const steps = await loadSteps(supabase, playbook.id);
      const { connectors, breakdown } = buildConnectorRequirements(steps);

      return {
        playbook,
        steps,
        step_count: steps.length,
        native_task_count: steps.filter((s) => s.type === "native_task").length,
        external_action_count: steps.filter((s) => s.type === "external_action").length,
        connector_requirements: {
          connectors,
          breakdown,
          note:
            connectors.length > 0
              ? `This playbook requires: ${connectors.join(", ")}. ` +
                "Verify these MCP connectors are available before running. " +
                "Steps with unavailable connectors will fall back to native tasks if fallback_task is set."
              : "This playbook has no external action steps. No MCP connectors required.",
        },
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // run_playbook
  // ──────────────────────────────────────────────────────────
  run_playbook: {
    title: "Run Playbook",
    description:
      "Execute a playbook against a customer. " +
      "Set preflight_only: true to inspect connector requirements and step breakdown WITHOUT executing — " +
      "use this to check what's needed before committing to a run. " +
      "In normal mode: creates all native_task steps as Founders OS tasks (linked to the customer) " +
      "and returns external_action steps as structured instructions. " +
      "IMPORTANT: After this tool returns in normal mode, check external_actions and execute each one " +
      "using the appropriate connected MCP tools. If a connector is unavailable, create a native task " +
      "using the fallback_task field from that step instead. " +
      "The response always includes connector_requirements so you know what to check before executing.",
    parameters: z.object({
      playbook_id: z
        .string()
        .describe("Playbook UUID or slug."),
      customer_id: z
        .string()
        .uuid()
        .optional()
        .describe("Customer UUID to run this playbook for. Strongly recommended — enables placeholder resolution."),
      start_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Anchor date (YYYY-MM-DD) for due_offset calculations and {{playbook.start_date}} placeholders."),
      preflight_only: z
        .boolean()
        .optional()
        .describe(
          "If true, return connector requirements and a step summary WITHOUT executing. " +
          "Use this to check what the playbook needs before committing to a run."
        ),
      notes: z
        .string()
        .optional()
        .describe("Optional context note logged with the run."),
    }),
    handler: async (ctx: ToolContext, {
      playbook_id,
      customer_id,
      start_date,
      preflight_only,
      notes,
    }: {
      playbook_id: string;
      customer_id?: string;
      start_date: string;
      preflight_only?: boolean;
      notes?: string;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;
      const userId = ctx.userId;

      const playbook = await resolvePlaybook(supabase, playbook_id, companyId);
      const steps = await loadSteps(supabase, playbook.id);

      if (steps.length === 0) {
        return {
          success: false,
          message: "Playbook has no steps. Add steps with add_playbook_step first.",
          playbook,
        };
      }

      const { connectors, breakdown } = buildConnectorRequirements(steps);
      const connectorRequirements = {
        connectors,
        breakdown,
        note:
          connectors.length > 0
            ? `Requires: ${connectors.join(", ")}. ` +
              "Check these connectors are available. Steps with unavailable connectors " +
              "will need to be handled via their fallback_task field."
            : "No external connectors required.",
      };

      // ── Preflight mode: return requirements without executing ──
      if (preflight_only) {
        return {
          preflight: true,
          playbook: { id: playbook.id, name: playbook.name, slug: playbook.slug },
          start_date,
          customer_id: customer_id ?? null,
          total_steps: steps.length,
          native_task_count: steps.filter((s) => s.type === "native_task").length,
          external_action_count: steps.filter((s) => s.type === "external_action").length,
          connector_requirements: connectorRequirements,
          step_summary: steps.map((s) => ({
            order_index: s.order_index,
            type: s.type,
            title: s.title,
            connector: s.connector ?? null,
            action: s.action ?? null,
            has_fallback: !!s.fallback_task,
            due_offset: s.due_offset ?? null,
          })),
          guidance:
            "Preflight complete. Review connector_requirements and step_summary, " +
            "then call run_playbook again without preflight_only: true to execute.",
        };
      }

      // ── Load customer context for placeholder resolution ───
      let customer: CustomerRow | null = null;
      let primaryContact: ContactRow | null = null;

      if (customer_id) {
        const [custRes, contactRes] = await Promise.all([
          supabase
            .from("customers")
            .select("id, organization_name")
            .eq("id", customer_id)
            .eq("company_id", companyId)
            .is("deleted_at", null)
            .single(),
          supabase
            .from("contacts")
            .select("first_name, last_name, email")
            .eq("customer_id", customer_id)
            .eq("is_primary", true)
            .eq("is_active", true)
            .is("deleted_at", null)
            .single(),
        ]);

        if (custRes.error)
          throw new Error(`Customer not found: ${custRes.error.message}`);
        customer = custRes.data as CustomerRow;
        if (!contactRes.error) primaryContact = contactRes.data as ContactRow;
      }

      const placeholders: PlaceholderContext = {
        customerName: customer?.organization_name ?? "",
        customerSlug: customer ? toSlug(customer.organization_name) : "",
        primaryContactName: primaryContact
          ? `${primaryContact.first_name} ${primaryContact.last_name}`.trim()
          : "",
        primaryContactEmail: primaryContact?.email ?? "",
        startDate: start_date,
      };

      // Create a run record
      const { data: run, error: runErr } = await supabase
        .from("playbook_runs")
        .insert({
          playbook_id: playbook.id,
          company_id: companyId,
          customer_id: customer_id ?? null,
          started_by: userId,
          start_date,
          status: "running",
          execution_log: notes ? [{ note: notes }] : [],
        })
        .select()
        .single();
      if (runErr) throw new Error(`Failed to create run: ${runErr.message}`);

      const runId = (run as { id: string }).id;

      // ── Execute steps ──────────────────────────────────────
      const executionLog: Record<string, unknown>[] = [];
      const createdTasks: Record<string, unknown>[] = [];
      const externalActions: Record<string, unknown>[] = [];
      let hasErrors = false;

      for (const step of steps) {
        const resolvedTitle = resolvePlaceholders(step.title, placeholders);
        const resolvedDescription = step.description
          ? resolvePlaceholders(step.description, placeholders)
          : null;

        if (step.type === "native_task") {
          const dueDate = step.due_offset != null
            ? addDays(start_date, step.due_offset)
            : null;

          const { data: task, error: taskErr } = await supabase
            .from("tasks")
            .insert({
              title: resolvedTitle,
              description: resolvedDescription,
              status: "todo",
              priority: step.priority,
              scope: "org",
              created_by: userId,
              assigned_to: step.assignee ?? null,
              due_date: dueDate,
              tags: [],
              company_id: companyId,
            })
            .select()
            .single();

          if (taskErr) {
            hasErrors = true;
            executionLog.push({
              step_id: step.id,
              order_index: step.order_index,
              type: "native_task",
              title: resolvedTitle,
              outcome: "error",
              error: taskErr.message,
            });
            continue;
          }

          // Link task to customer. company_id is denormalized onto task_links
          // (migration 032) so reads through the junction can scope directly.
          if (customer_id) {
            await supabase.from("task_links").insert({
              task_id: (task as { id: string }).id,
              entity_type: "customer",
              entity_id: customer_id,
              company_id: companyId,
            });
          }

          createdTasks.push(task as Record<string, unknown>);
          executionLog.push({
            step_id: step.id,
            order_index: step.order_index,
            type: "native_task",
            title: resolvedTitle,
            outcome: "created",
            task_id: (task as { id: string }).id,
            due_date: dueDate,
          });

        } else if (step.type === "external_action") {
          const resolvedParams = step.params
            ? resolveJsonPlaceholders(step.params, placeholders)
            : null;

          externalActions.push({
            step_id: step.id,
            order_index: step.order_index,
            title: resolvedTitle,
            connector: step.connector,
            action: step.action,
            params: resolvedParams,
            fallback_task: step.fallback_task
              ? resolvePlaceholders(step.fallback_task, placeholders)
              : null,
          });

          executionLog.push({
            step_id: step.id,
            order_index: step.order_index,
            type: "external_action",
            title: resolvedTitle,
            outcome: "emitted",
            connector: step.connector,
            action: step.action,
          });
        }
      }

      // Status: "partial" only when step errors occurred. External actions
      // pending execution does not make the run partial — that is expected.
      const finalStatus = hasErrors ? "partial" : "complete";

      await supabase
        .from("playbook_runs")
        .update({
          status: finalStatus,
          execution_log: executionLog,
          completed_at: new Date().toISOString(),
        })
        .eq("id", runId);

      // Clean up any run-scoped watchers this run installed (triggers bound
      // to the run itself). Customer/project-bound watchers persist; they are
      // cleaned up when their own entity is archived.
      await cascadeTriggersForEntity(ctx, "playbook_run", runId);

      const actionMsg =
        externalActions.length > 0
          ? `Execute the ${externalActions.length} item(s) in external_actions using connected MCP tools. ` +
            `If a connector is unavailable, create a native task using the step's fallback_task value.`
          : "No external actions required.";

      await writeAuditLog(ctx, {
        action: "run_playbook",
        entity_type: "playbook",
        entity_id: playbook.id,
        metadata: {
          run_id: runId,
          playbook_name: playbook.name,
          customer_id: customer?.id ?? null,
          customer_name: customer?.organization_name ?? null,
          tasks_created_count: createdTasks.length,
          external_actions_count: externalActions.length,
          has_errors: hasErrors,
        },
      });

      return {
        success: true,
        run_id: runId,
        status: finalStatus,
        playbook: { id: playbook.id, name: playbook.name, slug: playbook.slug },
        customer: customer
          ? { id: customer.id, name: customer.organization_name }
          : null,
        start_date,
        tasks_created: createdTasks,
        tasks_created_count: createdTasks.length,
        external_actions: externalActions,
        external_actions_count: externalActions.length,
        connector_requirements: connectorRequirements,
        execution_log: executionLog,
        has_errors: hasErrors,
        message: hasErrors
          ? `Playbook run completed with errors. ${createdTasks.length} task(s) created. ` +
            `Check execution_log for details. ${actionMsg}`
          : `Playbook run complete. ${createdTasks.length} task(s) created. ${actionMsg}`,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_playbook_run
  // ──────────────────────────────────────────────────────────
  get_playbook_run: {
    title: "Get Playbook Run",
    description:
      "Fetch the execution log and status of a specific playbook run.",
    parameters: z.object({
      run_id: z.string().uuid().describe("Playbook run UUID."),
    }),
    handler: async (ctx: ToolContext, { run_id }: { run_id: string }) => {
      const supabase = ctx.db;
      const { data, error } = await supabase
        .from("playbook_runs")
        .select("*")
        .eq("id", run_id)
        .eq("company_id", ctx.companyId)
        .single();
      if (error) throw new Error(`Run not found: ${error.message}`);
      return { run: data };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_playbook_runs
  // ──────────────────────────────────────────────────────────
  list_playbook_runs: {
    title: "List Playbook Runs",
    description:
      "List playbook execution history. Optionally filter by playbook or customer.",
    parameters: z.object({
      playbook_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter to runs of a specific playbook."),
      customer_id: z
        .string()
        .uuid()
        .optional()
        .describe("Filter to runs for a specific customer."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results. Defaults to 25."),
    }),
    handler: async (ctx: ToolContext, {
      playbook_id,
      customer_id,
      limit = 25,
    }: {
      playbook_id?: string;
      customer_id?: string;
      limit?: number;
    }) => {
      const supabase = ctx.db;
      let query = supabase
        .from("playbook_runs")
        .select(
          "id, playbook_id, customer_id, started_by, start_date, status, completed_at, created_at"
        )
        .eq("company_id", ctx.companyId)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (playbook_id) query = query.eq("playbook_id", playbook_id);
      if (customer_id) query = query.eq("customer_id", customer_id);

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list runs: ${error.message}`);
      return { runs: data ?? [], count: data?.length ?? 0 };
    },
  },

  // ──────────────────────────────────────────────────────────
  // update_playbook_step
  // ──────────────────────────────────────────────────────────
  update_playbook_step: {
    title: "Update Playbook Step",
    description:
      "Update any fields on a playbook step. Only provided fields are changed. " +
      "Use to refine a step's title, description, due_offset, assigned_to, or action params.",
    parameters: z.object({
      step_id: z.string().uuid().describe("Playbook step UUID."),
      order_index: z.number().int().optional().describe("New position in step sequence."),
      title: z.string().optional().describe("Updated title. Supports {{placeholders}}."),
      description: z.string().optional().describe("Updated description."),
      assigned_to: z.string().optional().describe("Updated assignee for native_task steps."),
      assignee: z.string().optional().describe("Deprecated: use `assigned_to`."),
      due_offset: z
        .number()
        .int()
        .optional()
        .describe("Updated due offset in days. Pass -1 to clear."),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      connector: z.string().optional(),
      action: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional().describe("Updated connector params."),
      fallback_task: z.string().optional().describe("Updated fallback task title."),
    }),
    handler: async (ctx: ToolContext, rawParams: {
      step_id: string;
      order_index?: number;
      title?: string;
      description?: string;
      assigned_to?: string;
      assignee?: string;
      due_offset?: number;
      priority?: "low" | "medium" | "high" | "urgent";
      connector?: string;
      action?: string;
      params?: Record<string, unknown>;
      fallback_task?: string;
    }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;

      // Verify step belongs to a playbook in this company
      const { data: existing, error: findErr } = await supabase
        .from("playbook_steps")
        .select("id, playbook_id")
        .eq("id", rawParams.step_id)
        .is("deleted_at", null)
        .single();
      if (findErr || !existing) throw new Error("Step not found.");

      const { error: pbErr } = await supabase
        .from("playbooks")
        .select("id")
        .eq("id", (existing as { playbook_id: string }).playbook_id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .single();
      if (pbErr) throw new Error("Access denied.");

      const updates: Record<string, unknown> = {};
      if (rawParams.order_index !== undefined) updates.order_index = rawParams.order_index;
      if (rawParams.title !== undefined) updates.title = rawParams.title;
      if (rawParams.description !== undefined) updates.description = rawParams.description;
      const assigneeInput = rawParams.assigned_to ?? rawParams.assignee;
      if (assigneeInput !== undefined)
        updates.assignee = assigneeInput === "" ? null : assigneeInput;
      if (rawParams.due_offset !== undefined)
        updates.due_offset = rawParams.due_offset === -1 ? null : rawParams.due_offset;
      if (rawParams.priority !== undefined) updates.priority = rawParams.priority;
      if (rawParams.connector !== undefined)
        updates.connector = rawParams.connector === "" ? null : rawParams.connector;
      if (rawParams.action !== undefined)
        updates.action = rawParams.action === "" ? null : rawParams.action;
      if (rawParams.params !== undefined) updates.params = rawParams.params;
      if (rawParams.fallback_task !== undefined)
        updates.fallback_task = rawParams.fallback_task === "" ? null : rawParams.fallback_task;

      if (Object.keys(updates).length === 0) {
        return { success: true, message: "No fields to update." };
      }

      const { data, error } = await supabase
        .from("playbook_steps")
        .update(updates)
        .eq("id", rawParams.step_id)
        .select()
        .single();
      if (error) throw new Error(`Failed to update step: ${error.message}`);
      return { success: true, step: data as PlaybookStepRow };
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_playbook_step
  // ──────────────────────────────────────────────────────────
  remove_playbook_step: {
    title: "Remove Playbook Step",
    description:
      "Remove a step from a playbook by archiving (hides from step list, recoverable) " +
      "or permanently deleting. On first call, returns a conflict with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. Tasks already created by previous runs are not affected.",
    parameters: z.object({
      step_id: z.string().uuid().describe("Playbook step UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, { step_id, mode, resolution }: { step_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      const supabase = ctx.db;
      const companyId = ctx.companyId;

      // Fetch step with playbook info for permission/label
      const { data: existing, error: findErr } = await supabase
        .from("playbook_steps")
        .select("id, playbook_id, title, order_index, type, description")
        .eq("id", step_id)
        .is("deleted_at", null)
        .single();
      if (findErr || !existing) throw new Error("Step not found.");

      const step = existing as PlaybookStepRow;

      const { data: pb, error: pbErr } = await supabase
        .from("playbooks")
        .select("id, company_id")
        .eq("id", step.playbook_id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .single();
      if (pbErr || !pb) throw new Error("Access denied.");

      return handleRemove({
        ctx,
        entity_type: "playbook_step",
        entity_id: step_id,
        entity_label: step.title,
        scope: "org",
        company_id: companyId,
        mode,
        resolution,
        before_state: {
          title: step.title,
          order_index: step.order_index,
          type: step.type,
          playbook_id: step.playbook_id,
        },
        archiveFn: async () => {
          const { data, error } = await supabase
            .from("playbook_steps")
            .update({ archived: true })
            .eq("id", step_id)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive step: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          const { data, error } = await supabase
            .from("playbook_steps")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", step_id)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete step: ${error.message}`);
          return data;
        },
      });
    },
  },
};

export function registerPlaybookTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, playbookTools, ctx);
}
