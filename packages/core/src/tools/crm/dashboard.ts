import { z } from "zod";
import { getLocalDateStr } from "../dates.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

export const dashboardTools = {
  get_dashboard: {
    title: "Get Dashboard",
    description:
      "Get a CRM dashboard summary: total customers by type and phase, overdue tasks, " +
      "recent interactions, and upcoming tasks within a 7/14/30-day window. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      days: z
        .union([z.literal(7), z.literal(14), z.literal(30)])
        .optional()
        .default(7)
        .describe(
          "Window for upcoming tasks in days (7, 14, or 30). Defaults to 7."
        ),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone string (e.g. 'America/New_York'). Used for timezone-aware date calculations."
        ),
    }),
    handler: async (ctx: ToolContext, { days = 7, timezone }: { days?: 7 | 14 | 30; timezone?: string }) => {
      const today = getLocalDateStr(timezone);
      const windowEnd = getLocalDateStr(timezone, days);

      // Helper: get task IDs linked to customers (for CRM-relevant task queries)
      const customerLinkedTasksQuery = () =>
        ctx.db
          .from("task_links")
          .select("task_id")
          .eq("entity_type", "customer")
          .eq("company_id", ctx.companyId);

      const [
        customersRes,
        customerLinkedIdsRes,
        recentInteractionsRes,
        customersByTypeRes,
        allOpenTasksRes,
      ] = await Promise.all([
        ctx.db
          .from("customers")
          .select("id", { count: "exact", head: true })
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null),
        customerLinkedTasksQuery(),
        // Inner-join customers and require a non-deleted parent so interactions
        // belonging to soft-deleted customers (including legacy orphans whose
        // cascade never ran) don't surface in recent activity.
        ctx.db
          .from("interactions")
          .select("*, customers!inner(organization_name, deleted_at)")
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .is("customers.deleted_at", null)
          .gte(
            "interaction_date",
            new Date(Date.now() - 7 * 86_400_000).toISOString()
          )
          .order("interaction_date", { ascending: false })
          .limit(10),
        ctx.db
          .from("customers")
          .select("customer_type, customer_phase")
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null),
        ctx.db
          .from("tasks")
          .select("due_date, title, status")
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .neq("status", "done")
          .order("due_date", { ascending: true }),
      ]);

      // Get customer-linked task IDs
      const linkedTaskIds = (customerLinkedIdsRes.data ?? []).map(
        (r: { task_id: string }) => r.task_id
      );

      // Fetch overdue and upcoming tasks that are linked to customers.
      // linkedTaskIds was already company-scoped above, but the explicit
      // .eq("company_id", ...) is defense in depth and keeps the
      // convention uniform across the file.
      const [overdueRes, upcomingRes] = await Promise.all([
        linkedTaskIds.length > 0
          ? ctx.db
              .from("tasks")
              .select("*, task_links!inner(entity_type, entity_id)")
              .in("id", linkedTaskIds)
              .eq("company_id", ctx.companyId)
              .is("deleted_at", null)
              .lt("due_date", today)
              .not("due_date", "is", null)
              .neq("status", "done")
              .order("due_date", { ascending: true })
              .limit(10)
          : Promise.resolve({ data: [] }),

        linkedTaskIds.length > 0
          ? ctx.db
              .from("tasks")
              .select("*, task_links!inner(entity_type, entity_id)")
              .in("id", linkedTaskIds)
              .eq("company_id", ctx.companyId)
              .is("deleted_at", null)
              .gte("due_date", today)
              .lte("due_date", windowEnd)
              .neq("status", "done")
              .order("due_date", { ascending: true })
              .limit(10)
          : Promise.resolve({ data: [] }),
      ]);

      // Build customer type/phase counts
      const typeCounts: Record<string, number> = {};
      const phaseCounts: Record<string, number> = {};
      if (customersByTypeRes.data) {
        for (const row of customersByTypeRes.data as {
          customer_type: string;
          customer_phase: string;
        }[]) {
          typeCounts[row.customer_type] =
            (typeCounts[row.customer_type] ?? 0) + 1;
          phaseCounts[row.customer_phase] =
            (phaseCounts[row.customer_phase] ?? 0) + 1;
        }
      }

      // Build tasks-by-due-date calendar view
      const dueDateMap = new Map<string, { count: number; tasks: Set<string> }>();
      if (allOpenTasksRes.data) {
        for (const row of allOpenTasksRes.data as {
          due_date: string | null;
          title: string;
        }[]) {
          const key = row.due_date ?? "none";
          if (!dueDateMap.has(key)) {
            dueDateMap.set(key, { count: 0, tasks: new Set() });
          }
          const entry = dueDateMap.get(key)!;
          entry.count++;
          entry.tasks.add(row.title);
        }
      }

      const allOpenTasksByDueDate = Array.from(dueDateMap.entries()).map(
        ([date, { count, tasks }]) => ({
          due_date: date === "none" ? null : date,
          count,
          tasks: Array.from(tasks),
        })
      );

      // Build tier_3 markdown fallback
      const totalCustomers = customersRes.count ?? 0;
      const overdueCount = overdueRes.data?.length ?? 0;
      const recentCount = recentInteractionsRes.data?.length ?? 0;
      const upcomingCount = upcomingRes.data?.length ?? 0;

      const typeRows = Object.entries(typeCounts)
        .map(([type, count]) => `| ${type} | ${count} |`)
        .join("\n");
      const phaseRows = Object.entries(phaseCounts)
        .map(([phase, count]) => `| ${phase} | ${count} |`)
        .join("\n");

      const markdownTable =
        `**Customers:** ${totalCustomers} total\n\n` +
        (typeRows
          ? `| Type | Count |\n|------|-------|\n${typeRows}\n\n`
          : "") +
        (phaseRows
          ? `| Phase | Count |\n|-------|-------|\n${phaseRows}\n\n`
          : "") +
        `**Overdue tasks:** ${overdueCount} | **Recent interactions:** ${recentCount} | **Upcoming (${days}d):** ${upcomingCount}`;

      return {
        total_customers: totalCustomers,
        customers_by_type: typeCounts,
        customers_by_phase: phaseCounts,
        overdue_tasks: overdueRes.data ?? [],
        recent_interactions: recentInteractionsRes.data ?? [],
        upcoming_tasks: upcomingRes.data ?? [],
        upcoming_window_days: days,
        all_open_tasks_by_due_date: allOpenTasksByDueDate,
        render: {
          tier_1: {
            format_hint: "metric_cards",
            instructions: {
              scope:
                "show the headline numbers (total_customers, overdue_tasks count, " +
                "recent_interactions count, upcoming_tasks count) prominently, " +
                "then the customers_by_type and customers_by_phase breakdowns, " +
                "then grouped sections for overdue_tasks and upcoming_tasks.",
              format:
                "headline numbers at the top in bold, breakdown sections beneath " +
                "using grouped lists with secondary labels. Apply the standard " +
                "color conventions (red on the overdue number, amber for " +
                "due-today, neutral elsewhere).",
              forbidden:
                "do not bury the overdue count (it is the most important number); " +
                "do not omit customers_by_type when type counts exist.",
            },
          },
          tier_3: {
            markdown: markdownTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
            "When total_customers is 0, empty-state copy is fine.",
          ],
        } satisfies Render,
      };
    },
  },
};
