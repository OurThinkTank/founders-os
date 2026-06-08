// ============================================================
// Founders OS - Surface Tools (v0.6.0)
// ============================================================
// Cross-domain read views for AI agent orientation.
//
// get_session_start - pointer tool that tells the agent which
//   tools to call in parallel for a complete briefing. No queries.
// get_entity_card   - full picture of any entity (record + tasks
//   + interactions + transactions)
// get_weekly_retro  - completed tasks grouped by tag, optional
//   LinkedIn draft format
// get_stuck_list    - stale, blocked, and overdue tasks with
//   triage suggestions
//
// Pattern A (stateless) - each handler creates its own DB client.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { getLocalDateStr, getLocalTime, getTimeOfDay, getLocalTimezone } from "../dates.js";
import { getFinancialAccess, financialPermissionError } from "../financial/access.js";
import { RENDERING_CONTRACT, RENDERING_CONTRACT_VERSION } from "../../contract.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

// Note: getFinancialAccess() (financial/access.js) still reads env vars
// directly. Its ctx refactor is deferred — see oss-launch-plan.md
// "Post-Launch Foundation Work". Surface handlers are contextual; they
// call into the legacy helper, which is allowed by the tool-context lint
// because the lint only inspects literal createServiceClient/getCompanyId/
// getUserId references inside contextual handler bodies, not indirect calls.

// Valid entity types for get_entity_card
const cardEntityType = z.enum([
  "customer",
  "contact",
  "transaction",
]);

export const surfaceTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // get_entity_card
  // ──────────────────────────────────────────────────────────
  get_entity_card: {
    title: "Get Entity Card",
    description:
      "Get a complete picture of any entity: the record itself, all open tasks linked to it, " +
      "recent interactions, and any linked transactions. Replaces multiple separate calls " +
      "when you need to answer 'what's going on with X?'",
    parameters: z.object({
      entity_type: cardEntityType.describe(
        "Type of entity: customer | contact | transaction"
      ),
      entity_id: z.string().uuid().describe("UUID of the entity."),
    }),
    handler: async (ctx: ToolContext, {
      entity_type,
      entity_id,
    }: {
      entity_type: "customer" | "contact" | "transaction";
      entity_id: string;
    }) => {
      // Financial data requires at least read access
      if (entity_type === "transaction") {
        const access = await getFinancialAccess(ctx);
        if (access === "none") return financialPermissionError("read");
      }

      // 1. Fetch the entity itself
      let entity: Record<string, unknown> | null = null;

      if (entity_type === "customer") {
        const { data, error } = await ctx.db
          .from("customers")
          .select("*")
          .eq("id", entity_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();
        if (error) throw new Error(`Customer not found: ${error.message}`);
        entity = data;
      } else if (entity_type === "contact") {
        const { data, error } = await ctx.db
          .from("contacts")
          .select("*, customers(organization_name)")
          .eq("id", entity_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .is("customers.deleted_at", null)
          .single();
        if (error) throw new Error(`Contact not found: ${error.message}`);
        entity = data;
      } else if (entity_type === "transaction") {
        const { data, error } = await ctx.db
          .from("financial_transactions")
          .select("*, financial_categories(name,type), financial_accounts!account_id(name)")
          .eq("id", entity_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .is("financial_categories.deleted_at", null)
          .is("financial_accounts.deleted_at", null)
          .single();
        if (error) throw new Error(`Transaction not found: ${error.message}`);
        entity = data;
        // Attach the attributed customer (if any, and not soft-deleted) so the
        // relationship is visible from the transaction side too. Resolved with a
        // separate company-scoped query rather than an embed: customer_id is
        // nullable (an embed filter would inner-join and drop customer-less rows).
        const attributedCustomerId =
          (data as { customer_id?: string | null } | null)?.customer_id ?? null;
        if (attributedCustomerId) {
          const { data: cust } = await ctx.db
            .from("customers")
            .select("id, organization_name")
            .eq("id", attributedCustomerId)
            .eq("company_id", ctx.companyId)
            .is("deleted_at", null)
            .single();
          (entity as Record<string, unknown>).customer = cust ?? null;
        }
      }

      // 2. Fetch open tasks linked to this entity. task_links carries
      // company_id directly (migration 032), so the junction read scopes
      // without joining tasks; the tasks read then scopes again as a
      // belt-and-suspenders against an inconsistent task_links row.
      const { data: linkRows } = await ctx.db
        .from("task_links")
        .select("task_id")
        .eq("entity_type", entity_type)
        .eq("entity_id", entity_id)
        .eq("company_id", ctx.companyId);

      const taskIds = (linkRows ?? []).map((r: { task_id: string }) => r.task_id);

      let openTasks: unknown[] = [];
      if (taskIds.length > 0) {
        const { data } = await ctx.db
          .from("tasks")
          .select("id, title, status, priority, assigned_to, due_date, tags, blocked_by_task_id")
          .in("id", taskIds)
          .eq("company_id", ctx.companyId)
          .neq("status", "done")
          .is("deleted_at", null)
          .order("due_date", { ascending: true, nullsFirst: false });
        openTasks = data ?? [];
      }

      // 3. Recent interactions (for customer and contact types)
      let recentInteractions: unknown[] = [];
      if (entity_type === "customer") {
        const { data } = await ctx.db
          .from("interactions")
          .select("id, interaction_type, subject, interaction_date")
          .eq("customer_id", entity_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .order("interaction_date", { ascending: false })
          .limit(5);
        recentInteractions = data ?? [];
      } else if (entity_type === "contact") {
        const { data } = await ctx.db
          .from("interactions")
          .select("id, interaction_type, subject, interaction_date")
          .eq("contact_id", entity_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .order("interaction_date", { ascending: false })
          .limit(5);
        recentInteractions = data ?? [];
      }

      // 4. Linked transactions (for customer type).
      // Two sources, merged: (4a) direct attribution via customer_id, and
      // (4b) the legacy task-mediated path (a task that links both the customer
      // and a transaction). Both are company-scoped and apply the same
      // archived + deleted_at filters so the merged set stays consistent.
      let linkedTransactions: unknown[] = [];
      if (entity_type === "customer") {
        const txSelect = "id, description, amount, date, customer_id, financial_categories(name)";

        // 4a. Direct attribution.
        const { data: directTx } = await ctx.db
          .from("financial_transactions")
          .select(txSelect)
          .eq("company_id", ctx.companyId)
          .eq("customer_id", entity_id)
          .eq("archived", false)
          .is("deleted_at", null)
          .is("financial_categories.deleted_at", null)
          .order("date", { ascending: false })
          .limit(10);

        // 4b. Legacy task-mediated: transactions linked to the same tasks as this customer.
        const { data: txLinks } = await ctx.db
          .from("task_links")
          .select("entity_id")
          .in("task_id", taskIds.length > 0 ? taskIds : ["__none__"])
          .eq("entity_type", "transaction")
          .eq("company_id", ctx.companyId);
        const txIds = (txLinks ?? []).map((r: { entity_id: string }) => r.entity_id);

        let mediatedTx: unknown[] = [];
        if (txIds.length > 0) {
          const { data } = await ctx.db
            .from("financial_transactions")
            .select(txSelect)
            .eq("company_id", ctx.companyId)
            .in("id", txIds)
            .eq("archived", false)
            .is("deleted_at", null)
            .is("financial_categories.deleted_at", null)
            .order("date", { ascending: false })
            .limit(10);
          mediatedTx = data ?? [];
        }

        // Merge + dedupe by id, newest first, cap at 5 for display.
        const byId = new Map<string, { id: string; date?: string | null }>();
        for (const t of [...(directTx ?? []), ...mediatedTx] as { id: string; date?: string | null }[]) {
          if (!byId.has(t.id)) byId.set(t.id, t);
        }
        linkedTransactions = [...byId.values()]
          .sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")))
          .slice(0, 5);
      }

      return {
        entity_type,
        entity: entity,
        open_tasks: openTasks,
        open_task_count: openTasks.length,
        recent_interactions: recentInteractions,
        linked_transactions: linkedTransactions,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_session_start
  // ──────────────────────────────────────────────────────────
  get_session_start: {
    title: "Get Session Start",
    description:
      "Session orientation pointer. Returns today's date and a list of tools " +
      "to call in parallel for a complete morning briefing. Does not fetch data " +
      "itself - call the listed tools to get the actual content. Use this at the " +
      "start of every session or when the user says 'start my day', 'catch me up', " +
      "or similar. The response includes a rendering_contract field that defines " +
      "the four-tier render ladder used across every founders-os tool for the rest " +
      "of the session - read it before composing any founders-os output. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone string (e.g. 'America/New_York'). Passed through to " +
          "the tools you call so dates are computed in the user's local timezone."
        ),
      client_capabilities: z
        .enum(["visual_primitive_tool", "inline_html", "markdown", "prose"])
        .optional()
        .describe(
          "Declare the highest rendering tier this client supports so the agent " +
          "can skip the per-response ladder evaluation. Values mirror the four-tier " +
          "ladder in the rendering_contract field. Omit to default to " +
          "'visual_primitive_tool' (a warning fires on the response when omitted). " +
          "Reflects the plugin's intended target, not a runtime probe."
        ),
      expected_contract_version: z
        .number()
        .int()
        .optional()
        .describe(
          "The rendering contract version the caller expects (typically declared " +
          "by the cowork plugin's CLAUDE.md). When provided, the server compares " +
          "against its own RENDERING_CONTRACT_VERSION and emits a " +
          "contract_version_warning on mismatch. Omit when calling without the " +
          "cowork plugin; no comparison happens and no warning fires."
        ),
    }),
    handler: async (_ctx: ToolContext, {
      timezone,
      client_capabilities,
      expected_contract_version,
    }: {
      timezone?: string;
      client_capabilities?:
        | "visual_primitive_tool"
        | "inline_html"
        | "markdown"
        | "prose";
      expected_contract_version?: number;
    }) => {
      // get_session_start does no DB work — it's a pointer tool. The ctx
      // parameter is required for the contextual signature but is unused
      // here. Renamed to _ctx so TypeScript / lint catches accidental use.
      const resolvedTz = getLocalTimezone(timezone);
      const today = getLocalDateStr(resolvedTz);
      const localTime = getLocalTime(resolvedTz);
      const timeOfDay = getTimeOfDay(resolvedTz);

      // C2 - default the capability tier and warn on omission. The warning
      // is surfaced in the response payload AND written to stderr so a human
      // running the server in a terminal sees it during manual testing.
      const resolvedClientCapabilities =
        client_capabilities ?? "visual_primitive_tool";
      let client_capabilities_warning: string | undefined;
      if (!client_capabilities) {
        client_capabilities_warning =
          "Parameter omitted; defaulting to 'visual_primitive_tool'. Pass " +
          "client_capabilities explicitly to silence this warning.";
        process.stderr.write(
          `[founders-os] get_session_start: ${client_capabilities_warning}\n`
        );
      }

      // G2 - contract version sentinel. Mismatch is informational; we still
      // serve the response and let the agent fall back to graceful behavior.
      let contract_version_warning: string | undefined;
      if (
        typeof expected_contract_version === "number" &&
        expected_contract_version !== RENDERING_CONTRACT_VERSION
      ) {
        contract_version_warning =
          `Caller expects rendering_contract version ${expected_contract_version}, ` +
          `server is on version ${RENDERING_CONTRACT_VERSION}. Some rendering ` +
          `directives may be interpreted with the wrong shape.`;
        process.stderr.write(
          `[founders-os] get_session_start: ${contract_version_warning}\n`
        );
      }

      const render: Render = {
        tier_1: {
          format_hint: "parallel_briefing",
          instructions: {
            scope:
              "call every tool listed in call_these_tools and combine their " +
              "responses into a single briefing.",
            format:
              "use time_of_day for the greeting (e.g. 'Good afternoon'). Order " +
              "sections: overdue and blocked items first, then upcoming work, " +
              "then recent CRM activity, then feed headlines. Apply the standard " +
              "color conventions for status emphasis.",
            forbidden:
              "do not omit any tool from call_these_tools; do not assume morning " +
              "in the greeting (use time_of_day).",
          },
        },
        do_not: [
          "Do not invent new color meanings; use the standard color conventions.",
        ],
      };

      const result: Record<string, unknown> = {
        today,
        local_time: localTime,
        time_of_day: timeOfDay,
        timezone: resolvedTz,
        client_capabilities: resolvedClientCapabilities,
        contract_version: RENDERING_CONTRACT_VERSION,
        call_these_tools: [
          "get_task_summary",
          "get_stuck_list",
          "get_dashboard",
          "get_feed_briefing",
        ],
        render,
        rendering_contract: RENDERING_CONTRACT,
      };

      if (client_capabilities_warning) {
        result.client_capabilities_warning = client_capabilities_warning;
      }
      if (contract_version_warning) {
        result.contract_version_warning = contract_version_warning;
      }

      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_weekly_retro
  // ──────────────────────────────────────────────────────────
  get_weekly_retro: {
    title: "Get Weekly Retro",
    description:
      "Completed-task retrospective for a given week. Groups done tasks by their first tag, " +
      "includes completion notes as quotes, and optionally formats as a LinkedIn-ready draft. " +
      "Useful for weekly reviews, standup prep, and public updates. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      week_offset: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .describe(
          "0 = current week, 1 = last week, 2 = two weeks ago, etc. Defaults to 0."
        ),
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("Filter by scope. Omit for combined view."),
      format: z
        .enum(["structured", "linkedin"])
        .optional()
        .describe(
          "'structured' (default) returns grouped data. 'linkedin' returns a ready-to-post draft."
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g. 'America/New_York'). When provided, the Monday-to-Sunday " +
          "week boundary is computed in the caller's local calendar instead of the server's " +
          "timezone. Matches the pattern in get_stuck_list / get_task_summary."
        ),
    }),
    handler: async (ctx: ToolContext, {
      week_offset = 0,
      scope,
      format = "structured",
      timezone,
    }: {
      week_offset?: number;
      scope?: "personal" | "org";
      format?: "structured" | "linkedin";
      timezone?: string;
    }) => {
      const userId = ctx.userId;

      // Calculate week boundaries (Mon-Sun) in the caller's calendar.
      // FIX NEW-09: previously used new Date() + .getDay() + .setHours(0,0,0,0)
      // which all run in the server's local timezone. Now we compute "today"
      // as a YYYY-MM-DD string in the caller's tz, derive its day-of-week
      // from that calendar date, and convert local midnight Monday to UTC
      // for the query window. Mirrors how get_stuck_list / get_task_summary
      // use getLocalDateStr(timezone).
      const todayStr = getLocalDateStr(timezone);
      // Parse at noon UTC to avoid DST edge-case shifting when reading getUTCDay.
      const todayLocalAsUtc = new Date(`${todayStr}T12:00:00Z`);
      const dayOfWeek = todayLocalAsUtc.getUTCDay(); // 0=Sun, 1=Mon
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

      // Monday of the requested week, as a YYYY-MM-DD string in the local calendar.
      const mondayAsUtc = new Date(todayLocalAsUtc);
      mondayAsUtc.setUTCDate(todayLocalAsUtc.getUTCDate() + mondayOffset - week_offset * 7);
      const sundayAsUtc = new Date(mondayAsUtc);
      sundayAsUtc.setUTCDate(mondayAsUtc.getUTCDate() + 6);

      const mondayLocalStr = mondayAsUtc.toISOString().slice(0, 10);
      const sundayLocalStr = sundayAsUtc.toISOString().slice(0, 10);

      // Bound the query window. We use Monday 00:00 UTC and Monday+7 00:00
      // UTC of the local calendar dates. Tasks completed during the local
      // week land inside this UTC range for every timezone within
      // [UTC-12, UTC+14]. This intentionally widens by up to ~14h on each
      // edge; the cost is including a task completed at 11pm Sunday-of-the-
      // previous-week (in an extreme western tz) or 1am Monday-of-the-next-
      // week (extreme eastern). For the weekly retro use case that's fine -
      // it's not a strict bucketing job.
      const weekStartDate = new Date(`${mondayLocalStr}T00:00:00Z`);
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setUTCDate(weekStartDate.getUTCDate() + 7);
      const startStr = weekStartDate.toISOString();
      const endStr = weekEndDate.toISOString();

      const weekLabel = `${mondayLocalStr} to ${sundayLocalStr}`;

      // Fetch completed tasks in the window
      const scopeOrFilter = `scope.eq.org,and(scope.eq.personal,created_by.eq.${userId})`;

      let query = ctx.db
        .from("tasks")
        .select("id, title, tags, completed_at, assigned_to")
        .eq("company_id", ctx.companyId)
        .eq("status", "done")
        .gte("completed_at", startStr)
        .lt("completed_at", endStr)
        .is("deleted_at", null)
        .order("completed_at", { ascending: true });

      if (scope === "personal") {
        query = query.eq("scope", "personal").eq("created_by", userId);
      } else if (scope === "org") {
        query = query.eq("scope", "org");
      } else {
        query = query.or(scopeOrFilter);
      }

      const { data: tasks, error } = await query;
      if (error) throw new Error(`Failed to fetch retro data: ${error.message}`);

      const completedTasks = tasks ?? [];

      // Fetch completion notes for these tasks
      const taskIds = completedTasks.map((t: { id: string }) => t.id);
      let notesByTask: Record<string, string[]> = {};
      if (taskIds.length > 0) {
        const { data: notes } = await ctx.db
          .from("task_notes")
          .select("task_id, note")
          .in("task_id", taskIds)
          .order("created_at", { ascending: false });
        for (const n of (notes ?? []) as { task_id: string; note: string }[]) {
          if (!notesByTask[n.task_id]) notesByTask[n.task_id] = [];
          notesByTask[n.task_id].push(n.note);
        }
      }

      // Group by first tag
      const groups: Record<string, {
        tasks: { title: string; completed_at: string; assigned_to: string | null; notes: string[] }[];
      }> = {};

      for (const task of completedTasks as {
        id: string;
        title: string;
        tags: string[];
        completed_at: string;
        assigned_to: string | null;
      }[]) {
        const groupKey = task.tags?.[0] ?? "ungrouped";
        if (!groups[groupKey]) groups[groupKey] = { tasks: [] };
        groups[groupKey].tasks.push({
          title: task.title,
          completed_at: task.completed_at,
          assigned_to: task.assigned_to,
          notes: notesByTask[task.id] ?? [],
        });
      }

      // Build tier_3 markdown fallback
      const retroRows: string[] = [];
      for (const [tag, group] of Object.entries(groups)) {
        const label = tag === "ungrouped" ? "General" : tag;
        for (const t of group.tasks) {
          retroRows.push(
            `| ${label} | ${t.title} | ${t.completed_at?.split("T")[0] ?? "-"} |`
          );
        }
      }
      const retroTable =
        `**Week of ${weekLabel}** - ${completedTasks.length} completed\n\n` +
        `| Tag | Task | Completed |\n|-----|------|-----------|\n` +
        retroRows.join("\n");

      const structuredRender: Render = {
        tier_1: {
          format_hint: "status_groups",
          instructions: {
            scope:
              "render the `groups` object keyed by tag, with each group's tasks " +
              "shown beneath its tag header. Show total_completed as the headline.",
            format:
              "tag headers followed by a task list per group; completion date " +
              "as secondary metadata under each title. Apply the standard color " +
              "conventions (neutral for completed items).",
            forbidden:
              "do not collapse multiple groups into a single list; do not omit " +
              "completion notes when present.",
          },
        },
        tier_3: {
          markdown: retroTable,
        },
        do_not: [
          "Do not invent new color meanings; use the standard color conventions.",
        ],
      };

      if (format === "linkedin") {
        // Build a LinkedIn-ready draft.
        // Title-only by default - completion notes are internal engineering
        // documentation (UUIDs, file paths, incident-postmortem prose) and
        // are not safe to dump verbatim into a public post. A future change
        // can add a separate `public_completion_note` field on task_notes
        // for opt-in inclusion; until then, titles only.
        // (See plan-weekly-retro-draft-quality.md for context.)
        let draft = `This week in the build:\n\n`;
        for (const [tag, group] of Object.entries(groups)) {
          const label = tag === "ungrouped" ? "General" : tag;
          draft += `${label}\n`;
          for (const t of group.tasks) {
            draft += `- ${t.title}\n`;
          }
          draft += `\n`;
        }
        draft += `#buildinpublic #founders`;

        const linkedinRender: Render = {
          tier_1: {
            format_hint: "narrative",
            instructions: {
              scope:
                "render the `linkedin_draft` as a LinkedIn-shaped post. The " +
                "draft is a starting point - if it is a sparse title list, " +
                "polish it into a readable post; if it is already prose, " +
                "preserve it.",
              format:
                "paste-ready prose for LinkedIn. Add cohesive transitions " +
                "and a short intro or closing where they help the post read " +
                "well. Keep the user's voice; do not over-format.",
              forbidden:
                "do not change what was actually accomplished; do not add " +
                "items not in the draft.",
            },
          },
          tier_3: {
            markdown: draft,
          },
        };

        return {
          week: weekLabel,
          total_completed: completedTasks.length,
          linkedin_draft: draft,
          groups,
          render: linkedinRender,
        };
      }

      return {
        week: weekLabel,
        total_completed: completedTasks.length,
        groups,
        render: structuredRender,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_stuck_list
  // ──────────────────────────────────────────────────────────
  get_stuck_list: {
    title: "Get Stuck List",
    description:
      "Surface stuck, stale, and overdue tasks that need triage. Returns in_progress tasks " +
      "untouched for N days, blocked tasks, and overdue tasks (todo or in_progress with past " +
      "due date). Each row includes days_stale and a suggested triage action. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      max_age_days: z
        .number().int().min(1).max(90).optional()
        .describe("Days of inactivity that qualify as 'stale' for in_progress tasks. Defaults to 7."),
      scope: z
        .enum(["personal", "org"]).optional()
        .describe("Filter by scope. Omit for combined view."),
      timezone: z
        .string().optional()
        .describe("IANA timezone (e.g. 'America/New_York'). Used for accurate 'today' calculation."),
    }),
    handler: async (ctx: ToolContext, {
      max_age_days = 7,
      scope,
      timezone,
    }: {
      max_age_days?: number;
      scope?: "personal" | "org";
      timezone?: string;
    }) => {
      const userId = ctx.userId;
      const today = new Date();
      const todayStr = getLocalDateStr(timezone);
      const staleThreshold = new Date(
        Date.now() - max_age_days * 86_400_000
      ).toISOString();
      const scopeOrFilter = `scope.eq.org,and(scope.eq.personal,created_by.eq.${userId})`;
      // Shared column list for stale/blocked/overdue queries
      const stuckFields = "id,title,status,priority,assigned_to,due_date,updated_at,tags,blocked_reason,blocked_by_task_id";

      // 1. Stale in_progress tasks (updated_at older than threshold)
      let staleQuery = ctx.db
        .from("tasks")
        .select(stuckFields)
        .eq("company_id", ctx.companyId)
        .eq("status", "in_progress")
        .lt("updated_at", staleThreshold)
        .is("deleted_at", null);

      if (scope === "personal") {
        staleQuery = staleQuery.eq("scope", "personal").eq("created_by", userId);
      } else if (scope === "org") {
        staleQuery = staleQuery.eq("scope", "org");
      } else {
        staleQuery = staleQuery.or(scopeOrFilter);
      }

      // 2. All blocked tasks
      let blockedQuery = ctx.db
        .from("tasks")
        .select(stuckFields)
        .eq("company_id", ctx.companyId)
        .eq("status", "blocked")
        .is("deleted_at", null);

      if (scope === "personal") {
        blockedQuery = blockedQuery.eq("scope", "personal").eq("created_by", userId);
      } else if (scope === "org") {
        blockedQuery = blockedQuery.eq("scope", "org");
      } else {
        blockedQuery = blockedQuery.or(scopeOrFilter);
      }

      // 3. Overdue tasks (FIX NEW-06: was todo-only; now includes in_progress).
      let overdueQuery = ctx.db
        .from("tasks")
        .select(stuckFields)
        .eq("company_id", ctx.companyId)
        .in("status", ["todo", "in_progress"])
        .lt("due_date", todayStr)
        .not("due_date", "is", null)
        .is("deleted_at", null);

      if (scope === "personal") {
        overdueQuery = overdueQuery.eq("scope", "personal").eq("created_by", userId);
      } else if (scope === "org") {
        overdueQuery = overdueQuery.eq("scope", "org");
      } else {
        overdueQuery = overdueQuery.or(scopeOrFilter);
      }

      const [staleRes, blockedRes, overdueRes] = await Promise.all([
        staleQuery.limit(20),
        blockedQuery.limit(20),
        overdueQuery.limit(20),
      ]);

      type StuckTask = {
        id: string;
        title: string;
        status: string;
        priority: string;
        assigned_to: string | null;
        due_date: string | null;
        updated_at: string;
        tags: string[];
        blocked_reason: string | null;
        blocked_by_task_id: string | null;
      };

      // Deduplicate (a blocked task could also be overdue)
      const seen = new Set<string>();
      const stuckItems: {
        task: StuckTask;
        stuck_reason: string;
        days_stale: number;
        suggested_action: string;
      }[] = [];

      const addItem = (
        task: StuckTask,
        reason: string,
        action: string
      ) => {
        if (seen.has(task.id)) return;
        seen.add(task.id);
        const daysStale = Math.floor(
          (today.getTime() - new Date(task.updated_at).getTime()) / 86_400_000
        );
        stuckItems.push({
          task,
          stuck_reason: reason,
          days_stale: daysStale,
          suggested_action: action,
        });
      };

      for (const task of (staleRes.data ?? []) as StuckTask[]) {
        addItem(
          task,
          `In progress but untouched for ${Math.floor((today.getTime() - new Date(task.updated_at).getTime()) / 86_400_000)} days`,
          task.assigned_to
            ? `Check in with ${task.assigned_to} or add a progress note`
            : "Assign to someone or add a progress note"
        );
      }

      for (const task of (blockedRes.data ?? []) as StuckTask[]) {
        const action = task.blocked_by_task_id
          ? `Resolve blocking task or clear the dependency`
          : task.blocked_reason
          ? `Address blocker: ${task.blocked_reason}`
          : "Add a blocked_reason or resolve the blocker";
        addItem(task, "Blocked", action);
      }

      for (const task of (overdueRes.data ?? []) as StuckTask[]) {
        const daysOverdue = Math.floor(
          (today.getTime() - new Date(task.due_date + "T00:00:00Z").getTime()) / 86_400_000
        );
        addItem(
          task,
          `Overdue by ${daysOverdue} day${daysOverdue > 1 ? "s" : ""}`,
          "Complete it, reschedule, or delete if no longer relevant"
        );
      }

      // Sort by days_stale descending (worst offenders first)
      stuckItems.sort((a, b) => b.days_stale - a.days_stale);

      // Build tier_3 markdown fallback
      const markdownRows = stuckItems.map(
        (item) =>
          `| ${item.task.title} | ${item.stuck_reason} | ${item.suggested_action} |`
      );
      const markdownTable =
        markdownRows.length > 0
          ? "| Task | Reason | Suggested action |\n|------|--------|------------------|\n" +
            markdownRows.join("\n")
          : "No stuck tasks - everything is moving.";

      const render: Render = {
        tier_1: {
          format_hint: "status_groups",
          instructions: {
            scope:
              "render the `stuck_list` array sorted by days_stale descending " +
              "(worst offenders first). Group by stuck_reason category " +
              "(overdue, stale, blocked).",
            format:
              "callout list with the standard color conventions for emphasis " +
              "(red for overdue, amber for stale, neutral for blocked). Show " +
              "suggested_action as a next-step line beneath each title.",
            forbidden:
              "do not omit overdue items; do not reorder by another field; do " +
              "not show counts only (the per-item detail is the point).",
          },
        },
        tier_3: {
          markdown: markdownTable,
        },
        do_not: [
          "Do not invent new color meanings; use the standard color conventions.",
          "For 2 or fewer items, inline rendering is fine.",
        ],
      };

      return {
        stuck_list: stuckItems,
        total: stuckItems.length,
        stale_in_progress: staleRes.data?.length ?? 0,
        blocked: blockedRes.data?.length ?? 0,
        // FIX NEW-06: renamed from overdue_todo → overdue since it now includes in_progress
        overdue: overdueRes.data?.length ?? 0,
        render,
      };
    },
  },

};

export function registerSurfaceTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, surfaceTools, ctx);
}
