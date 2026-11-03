// ============================================================
// Founders OS - Shared filter params
// ============================================================
// Tag filtering is identical across every retrieval tool, so the
// schema fragment and matching logic live here. `tags` is the
// general (multi-value) filter; `tag` is a single-value shorthand.
// ============================================================

import { z } from "zod";
import type { ToolContext } from "../types/context.js";

export const tagFilterParams = {
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Filter to items carrying these tags. Combined per `tag_match` " +
      "(default 'all': the item must carry every listed tag)."
    ),
  tag_match: z
    .enum(["all", "any"])
    .optional()
    .describe(
      "How to combine `tags`: 'all' (item has every tag, default) or " +
      "'any' (item has at least one of them)."
    ),
  tag: z
    .string()
    .optional()
    .describe("Convenience filter for a single tag. Use `tags` for multiple."),
};

/**
 * Resolve the effective tag list from the `tags` array or the single-value
 * `tag` shorthand. Returns null when no tag filter was provided.
 */
export function resolveTagList(tag?: string, tags?: string[]): string[] | null {
  if (tags && tags.length > 0) return tags;
  if (tag) return [tag];
  return null;
}


// Starts a read of the tasks table with archived and soft-deleted rows
// already excluded. Chain any other filters onto the result as usual.
export function liveTasks(
  db: { from(table: string): { select(columns: string, options?: unknown): any } },
  columns = "*",
  options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }
): any {
  return db
    .from("tasks")
    .select(columns, options)
    .is("archived_at", null)
    .is("deleted_at", null);
}

// The .or() filter for the tasks a user can see: org tasks, plus personal
// tasks the user created.
export function taskVisibilityFilter(userId: string): string {
  return `scope.eq.org,and(scope.eq.personal,created_by.eq.${userId})`;
}

// Starts a read of the tasks the caller can see in their company, with
// archived and soft-deleted rows already excluded. Chain any other filters
// onto the result as usual.
export function visibleTasks(
  ctx: Pick<ToolContext, "db" | "companyId" | "userId">,
  columns = "*",
  options?: { count?: "exact" | "planned" | "estimated"; head?: boolean }
): any {
  return liveTasks(ctx.db, columns, options)
    .eq("company_id", ctx.companyId)
    .or(taskVisibilityFilter(ctx.userId));
}

// Fetches one task by id when the caller can see it. Archived tasks are
// included; soft-deleted tasks are not. Another user's personal task comes
// back as an error, the same as a task that does not exist.
export function findVisibleTask(
  ctx: Pick<ToolContext, "db" | "companyId" | "userId">,
  taskId: string,
  columns = "id"
): PromiseLike<{ data: any; error: any }> {
  return ctx.db
    .from("tasks")
    .select(columns)
    .eq("id", taskId)
    .eq("company_id", ctx.companyId)
    .is("deleted_at", null)
    .or(taskVisibilityFilter(ctx.userId))
    .single();
}
