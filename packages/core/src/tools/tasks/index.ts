// ============================================================
// Founders OS — Task Management Tools (v0.4.0)
// ============================================================
// 12 tools replacing the CRM follow_ups system.
// v0.4.0 additions: task dependencies (blocked_by_task_id),
// task-to-memory bridge, tag validation warnings.
//
// Scope model (mirrors Memory):
//   org      — visible to all team members sharing this company_id
//   personal — visible only to the creator (created_by match)
//
// AI assignees use an @ prefix: "@claude", "@gpt", etc.
// Human assignees use FOUNDERS_OS_USER_ID values.
//
// Universal entity linking via task_links junction table —
// a task can link to customers, contacts, transactions,
// contracts, memories, or any future entity type.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { validateTags } from "../tags/index.js";
import { embed } from "../memory/embed.js";
import { detectFirstRun, FIRST_RUN_HINT } from "../first-run.js";
import { getToday, getLocalDateStr, checkDateDay, type Weekday } from "../dates.js";
import { conflict } from "../conflict.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import { tagFilterParams, resolveTagList } from "../filters.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

// Note: helpers used inside contextual handlers below are all contextual:
//   - validateTags(ctx, ...) (tags-domain refactor 2026-05-28).
//   - embed(ctx, text) (memory/embed.ts refactor 2026-05-28).
//   - detectFirstRun() is pure / takes a client argument.
//   - The lint only forbids createServiceClient/getCompanyId/getUserId
//     directly inside contextual handler bodies; indirect helpers are fine.

// Valid entity types for task links
const entityTypeEnum = z.enum([
  "customer",
  "contact",
  "interaction",
  "transaction",
  "contract",
  "memory",
]);

type EntityType =
  | "customer"
  | "contact"
  | "interaction"
  | "transaction"
  | "contract"
  | "memory";

// Shape returned by get_task — task row + links + notes
interface TaskLink {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  created_at: string;
}

interface TaskNote {
  id: string;
  user_id: string;
  note: string;
  created_at: string;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  scope: string;
  created_by: string;
  assigned_to: string | null;
  blocked_reason: string | null;
  due_date: string | null;
  completed_at: string | null;
  tags: string[];
  company_id: string;
  created_at: string;
  updated_at: string;
}

export const taskTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // create_task
  // ──────────────────────────────────────────────────────────
  create_task: {
    title: "Create Task",
    description:
      "Create a new task. Scope 'org' (default) is visible to all team members; 'personal' is private to the creator. " +
      "Use assigned_to with a FOUNDERS_OS_USER_ID for human assignment, or '@claude' / '@gpt' for AI assignment. " +
      "Optionally link to any FounderOS entity (customer, contact, transaction, etc.) at creation time. " +
      "If the response contains a `conflict` field, the task was NOT created. Present all options to the user " +
      "using an interactive chooser (AskUserQuestion) if available, then retry with the selected date.",
    parameters: z.object({
      title: z.string().describe("What needs to be done."),
      description: z.string().optional().describe("Additional details or context."),
      status: z
        .enum(["todo", "in_progress", "blocked", "done"])
        .optional()
        .describe("Task status. Defaults to 'todo'."),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Priority level. Defaults to 'medium'."),
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("'org' (default) for team-visible; 'personal' for private."),
      assigned_to: z
        .string()
        .optional()
        .describe(
          "Who to assign this to. Use a FOUNDERS_OS_USER_ID for a human, or '@claude' / '@gpt' for AI. " +
            "A task takes exactly one assignee by design: the single accountable owner, the 'one neck to grab' (ONTG). " +
            "This is deliberate, not a limitation - work split across several names tends to get done by no one. " +
            "If several people are involved, still set one owner here and name the others in the description (or tag people you are waiting on with an @person tag)."
        ),
      blocked_reason: z
        .string()
        .optional()
        .describe("Required context when status is 'blocked'."),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Due date (YYYY-MM-DD)."),
      due_date_day: z
        .enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
        .optional()
        .describe(
          "Expected day of the week for due_date. If provided, the server validates it matches. " +
          "Catches errors when converting 'due Thursday' to a date. Mismatch returns the correct day and nearby alternatives."
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags for filtering and grouping (e.g. ['Q2', 'fundraising'])."),
      blocked_by_task_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "UUID of a task that blocks this one. Sets status to 'blocked' automatically if not already set."
        ),
      links: z
        .array(
          z.object({
            entity_type: entityTypeEnum.describe(
              "Type of entity to link: customer | contact | interaction | transaction | contract | memory"
            ),
            entity_id: z.string().describe("UUID of the linked entity."),
          })
        )
        .optional()
        .describe("Entities to link this task to at creation time."),
    }),
    handler: async (ctx: ToolContext, params: {
      title: string;
      description?: string;
      status?: "todo" | "in_progress" | "blocked" | "done";
      priority?: "low" | "medium" | "high" | "urgent";
      scope?: "personal" | "org";
      assigned_to?: string;
      blocked_reason?: string;
      due_date?: string;
      due_date_day?: Weekday;
      tags?: string[];
      blocked_by_task_id?: string;
      links?: { entity_type: EntityType; entity_id: string }[];
    }) => {
      // Day-of-week checksum: return structured conflict for interactive resolution
      if (params.due_date && params.due_date_day) {
        const dateConflict = checkDateDay(params.due_date, params.due_date_day);
        if (dateConflict) return dateConflict;
      }

      // If blocked_by_task_id is set and no explicit status, ask the user
      if (params.blocked_by_task_id && !params.status) {
        return conflict(
          "silent_default",
          "This task has a blocker. What status should it start with?",
          [
            {
              key: "blocked",
              label: "Blocked (wait for blocker to complete)",
              value: { status: "blocked" },
            },
            {
              key: "todo",
              label: "To-do (acknowledge dependency but start anyway)",
              value: { status: "todo" },
            },
          ],
          { blocked_by_task_id: params.blocked_by_task_id }
        );
      }

      const effectiveStatus = params.status ?? "todo";

      // Tag validation (advisory, with auto-registration for new tags)
      const tagResult =
        params.tags && params.tags.length > 0
          ? await validateTags(ctx, params.tags)
          : { warnings: [], auto_registered: [] };

      const { data: task, error } = await ctx.db
        .from("tasks")
        .insert({
          title: params.title,
          description: params.description ?? null,
          status: effectiveStatus,
          priority: params.priority ?? "medium",
          scope: params.scope ?? "org",
          created_by: ctx.userId,
          assigned_to: params.assigned_to ?? null,
          blocked_reason: params.blocked_reason ?? null,
          blocked_by_task_id: params.blocked_by_task_id ?? null,
          due_date: params.due_date ?? null,
          tags: params.tags ?? [],
          company_id: ctx.companyId,
          completed_at:
            effectiveStatus === "done" ? new Date().toISOString() : null,
        })
        .select()
        .single();

      if (error) throw new Error(`Failed to create task: ${error.message}`);

      // Insert links if provided. company_id is denormalized onto task_links
      // (migration 032) so reads through this junction can scope directly
      // rather than join through tasks on every call.
      if (params.links && params.links.length > 0) {
        const linkRows = params.links.map((l) => ({
          task_id: task.id,
          entity_type: l.entity_type,
          entity_id: l.entity_id,
          company_id: ctx.companyId,
        }));
        const { error: linkError } = await ctx.db
          .from("task_links")
          .insert(linkRows);
        if (linkError)
          throw new Error(`Task created but linking failed: ${linkError.message}`);
      }

      const result: Record<string, unknown> = { success: true, task };
      if (tagResult.warnings.length > 0) {
        result.tag_warnings = tagResult.warnings;
      }
      if (tagResult.auto_registered.length > 0) {
        result.tags_auto_registered = tagResult.auto_registered;
      }
      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_task
  // ──────────────────────────────────────────────────────────
  get_task: {
    title: "Get Task",
    description:
      "Fetch a single task by ID, including all linked entities and notes.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
    }),
    handler: async (ctx: ToolContext, { task_id }: { task_id: string }) => {
      // Verify task ownership first, then fetch links/notes (defense-in-depth)
      const taskRes = await ctx.db
        .from("tasks").select("*").eq("id", task_id).eq("company_id", ctx.companyId).is("deleted_at", null).single();
      if (taskRes.error)
        throw new Error(`Task not found: ${taskRes.error.message}`);

      const task = taskRes.data as TaskRow & { blocked_by_task_id?: string | null };

      const [linksRes, notesRes] = await Promise.all([
        ctx.db
          .from("task_links")
          .select("*")
          .eq("task_id", task_id)
          .eq("company_id", ctx.companyId)
          .order("created_at", { ascending: true }),
        ctx.db
          .from("task_notes")
          .select("*")
          .eq("task_id", task_id)
          .order("created_at", { ascending: true }),
      ]);

      // If blocked by another task, fetch the blocker's title and status
      let blocked_by: { id: string; title: string; status: string } | null = null;
      if (task.blocked_by_task_id) {
        const { data: blocker } = await ctx.db
          .from("tasks")
          .select("id, title, status")
          .eq("id", task.blocked_by_task_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();
        if (blocker) blocked_by = blocker;
      }

      // Check if any tasks are blocked by this one
      const { data: dependents } = await ctx.db
        .from("tasks")
        .select("id, title, status")
        .eq("blocked_by_task_id", task_id)
        .eq("company_id", ctx.companyId)
        .neq("status", "done")
        .is("deleted_at", null);

      return {
        task,
        links: (linksRes.data ?? []) as TaskLink[],
        notes: (notesRes.data ?? []) as TaskNote[],
        blocked_by,
        blocks: dependents ?? [],
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // update_task
  // ──────────────────────────────────────────────────────────
  update_task: {
    title: "Update Task",
    description:
      "Update any fields on a task. Only provided fields are changed. " +
      "Setting status to 'done' automatically sets completed_at. " +
      "If the response contains a `conflict` field, the update was NOT applied. Present all options to the user " +
      "using an interactive chooser (AskUserQuestion) if available, then retry with the selected date.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z
        .enum(["todo", "in_progress", "blocked", "done"])
        .optional()
        .describe("New status."),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
      scope: z.enum(["personal", "org"]).optional(),
      assigned_to: z
        .string()
        .optional()
        .describe("User ID or '@claude' / '@gpt'. Pass empty string to unassign."),
      blocked_reason: z.string().optional(),
      due_date: z
        .string()
        .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), {
          message: "Must be YYYY-MM-DD or empty string to clear.",
        })
        .optional()
        .describe("YYYY-MM-DD. Pass empty string to clear."),
      due_date_day: z
        .enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
        .optional()
        .describe(
          "Expected day of the week for due_date. If provided, the server validates it matches. " +
          "Catches errors when converting 'due Thursday' to a date. Mismatch returns the correct day and nearby alternatives."
        ),
      tags: z.array(z.string()).optional(),
      blocked_by_task_id: z
        .string()
        .optional()
        .describe(
          "UUID of a blocking task. Pass empty string to clear the dependency."
        ),
    }),
    handler: async (ctx: ToolContext, params: {
      task_id: string;
      title?: string;
      description?: string;
      status?: "todo" | "in_progress" | "blocked" | "done";
      priority?: "low" | "medium" | "high" | "urgent";
      scope?: "personal" | "org";
      assigned_to?: string;
      blocked_reason?: string;
      due_date?: string;
      due_date_day?: Weekday;
      tags?: string[];
      blocked_by_task_id?: string;
    }) => {
      const { task_id, ...fields } = params;

      // Day-of-week checksum: return structured conflict for interactive resolution
      if (fields.due_date && fields.due_date_day) {
        const dateConflict = checkDateDay(fields.due_date, fields.due_date_day);
        if (dateConflict) return dateConflict;
      }

      // Tag validation (advisory, with auto-registration for new tags)
      const tagResult =
        fields.tags && fields.tags.length > 0
          ? await validateTags(ctx, fields.tags)
          : { warnings: [], auto_registered: [] };

      const updates: Record<string, unknown> = {};
      if (fields.title !== undefined) updates.title = fields.title;
      if (fields.description !== undefined) updates.description = fields.description;
      if (fields.status !== undefined) {
        updates.status = fields.status;
        if (fields.status === "done") {
          updates.completed_at = new Date().toISOString();
        } else {
          updates.completed_at = null;
        }
      }
      if (fields.priority !== undefined) updates.priority = fields.priority;
      if (fields.scope !== undefined) updates.scope = fields.scope;
      if (fields.assigned_to !== undefined)
        updates.assigned_to = fields.assigned_to === "" ? null : fields.assigned_to;
      if (fields.blocked_reason !== undefined)
        updates.blocked_reason = fields.blocked_reason;
      if (fields.due_date !== undefined)
        updates.due_date = fields.due_date === "" ? null : fields.due_date;
      if (fields.tags !== undefined) updates.tags = fields.tags;
      if (fields.blocked_by_task_id !== undefined)
        updates.blocked_by_task_id =
          fields.blocked_by_task_id === "" ? null : fields.blocked_by_task_id;

      if (Object.keys(updates).length === 0) {
        return { success: true, message: "No fields to update." };
      }

      const { data, error } = await ctx.db
        .from("tasks")
        .update(updates)
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();

      if (error) throw new Error(`Failed to update task: ${error.message}`);

      const result: Record<string, unknown> = { success: true, task: data };
      if (tagResult.warnings.length > 0) {
        result.tag_warnings = tagResult.warnings;
      }
      if (tagResult.auto_registered.length > 0) {
        result.tags_auto_registered = tagResult.auto_registered;
      }
      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // complete_task
  // ──────────────────────────────────────────────────────────
  complete_task: {
    title: "Complete Task",
    description:
      "Mark a task as done. Optionally log a completion note. " +
      "Set store_as_memory=true to persist the completion as an org-scoped memory. " +
      "Returns unblocked_tasks if completing this task unblocks dependent tasks. " +
      "If the task is blocked by an incomplete task, a `conflict` response is returned. " +
      "Pass force=true to complete anyway after conflict resolution.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID to complete."),
      completion_note: z.string().optional()
        .describe("Summary of what was done. AI agents should always provide this."),
      store_as_memory: z.boolean().optional()
        .describe("If true and completion_note is provided, stores the completion as an org-scoped memory."),
      memory_project: z.string().optional()
        .describe("Project tag for the memory entry. Only used when store_as_memory is true."),
      resolution: z.enum(["confirm", "cancel"]).optional()
        .describe("Conflict resolution: 'confirm' completes despite the blocker, 'cancel' aborts."),
      force: z.boolean().optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Set true to skip the blocker check."),
    }),
    handler: async (ctx: ToolContext, {
      task_id, completion_note, store_as_memory, memory_project, force, resolution,
    }: {
      task_id: string; completion_note?: string;
      store_as_memory?: boolean; memory_project?: string;
      force?: boolean; resolution?: "confirm" | "cancel";
    }) => {
      if (resolution === "cancel") {
        return { success: false, message: "Cancelled. The task was not completed." };
      }
      const completeAnyway = force === true || resolution === "confirm";

      // FIX NEW-05: idempotency - return early if already done.
      const { data: cur, error: fe } = await ctx.db
        .from("tasks")
        .select("id, status, completed_at, blocked_by_task_id")
        .eq("id", task_id).eq("company_id", ctx.companyId).is("deleted_at", null).single();
      if (fe) throw new Error(`Task not found: ${fe.message}`);
      if (cur?.status === "done") {
        return { success: true, already_done: true, completed_at: cur.completed_at,
          message: "Already done." };
      }

      // Blocker check: if this task is blocked by an incomplete task, ask first
      if (!completeAnyway && cur?.blocked_by_task_id) {
        const { data: blocker } = await ctx.db
          .from("tasks")
          .select("id, title, status")
          .eq("id", cur.blocked_by_task_id)
          .eq("company_id", ctx.companyId)
          .is("deleted_at", null)
          .single();

        if (blocker && blocker.status !== "done") {
          return conflict(
            "ambiguous_input",
            `This task is blocked by "${blocker.title}" which is still ${blocker.status}. Complete anyway?`,
            [
              {
                key: "complete_anyway",
                label: "Complete this task (ignore blocker)",
                value: { task_id, resolution: "confirm" },
              },
              {
                key: "complete_blocker_first",
                label: `Complete "${blocker.title}" first`,
                value: { task_id: blocker.id },
              },
              { key: "cancel", label: "Cancel", value: { resolution: "cancel" } },
            ],
            { blocker: { id: blocker.id, title: blocker.title, status: blocker.status } }
          );
        }
      }

      const { data: task, error } = await ctx.db
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();

      if (error) throw new Error(`Failed to complete task: ${error.message}`);

      if (completion_note) {
        const { error: noteError } = await ctx.db.from("task_notes").insert({
          task_id,
          user_id: ctx.userId,
          note: completion_note,
        });
        if (noteError)
          throw new Error(
            `Task completed but note failed: ${noteError.message}`
          );
      }

      // Task-to-memory bridge
      let memory_stored = false;
      let memory_error: string | null = null;
      if (store_as_memory && completion_note) {
        try {
          const memoryContent = `Task completed: ${task.title}\n\n${completion_note}`;
          const embedding = await embed(ctx, memoryContent);
          const { error: memError } = await ctx.db.from("memories").insert({
            user_id: "org",
            company_id: ctx.companyId,
            scope: "org",
            project: memory_project ?? null,
            content: memoryContent,
            embedding: JSON.stringify(embedding),
            source_tool: "complete_task",
          });
          memory_stored = !memError;
          if (memError) memory_error = memError.message;
        } catch (e) {
          memory_error = e instanceof Error ? e.message : "Unknown embedding error";
        }
      }

      // Check for tasks that were blocked by this one
      const { data: unblocked } = await ctx.db
        .from("tasks")
        .select("id, title, status, assigned_to")
        .eq("blocked_by_task_id", task_id)
        .eq("company_id", ctx.companyId)
        .neq("status", "done")
        .is("deleted_at", null);

      const result: Record<string, unknown> = { success: true, task };
      if (store_as_memory) {
        result.memory_stored = memory_stored;
        if (memory_error) result.memory_error = memory_error;
        // FIX TC-CM01: surface an explicit warning when store_as_memory=true but no
        // completion_note was provided, so AI agents understand why memory was not stored.
        if (!completion_note) {
          result.memory_warning = "completion_note is required to store memory; no note was provided.";
        }
      }
      if (unblocked && unblocked.length > 0) {
        result.unblocked_tasks = unblocked;
        result.unblocked_count = unblocked.length;
      }
      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_task
  // ──────────────────────────────────────────────────────────
  remove_task: {
    title: "Remove Task",
    description:
      "Remove a task by archiving (hides from active views, recoverable) or permanently deleting. " +
      "On first call, returns a `conflict` with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. Delete removes the task and all its links and notes permanently. " +
      "Archive sets archived_at and preserves everything.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, { task_id, mode, resolution }: { task_id: string; mode?: RemoveMode; resolution?: RemoveResolution }) => {
      // Fetch task
      const { data: task, error: fetchErr } = await ctx.db
        .from("tasks")
        .select("id, title, status, scope, created_by, company_id")
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Task not found: ${fetchErr.message}`);

      // Gather linked data counts
      const [depsRes, notesRes, linksRes] = await Promise.all([
        ctx.db.from("tasks").select("id", { count: "exact", head: true })
          .eq("blocked_by_task_id", task_id).eq("company_id", ctx.companyId).neq("status", "done").is("deleted_at", null),
        ctx.db.from("task_notes").select("id", { count: "exact", head: true }).eq("task_id", task_id),
        ctx.db.from("task_links").select("id", { count: "exact", head: true }).eq("task_id", task_id).eq("company_id", ctx.companyId),
      ]);

      const linked_data: Record<string, number> = {};
      if ((depsRes.count ?? 0) > 0) linked_data["dependent task(s)"] = depsRes.count!;
      if ((notesRes.count ?? 0) > 0) linked_data["note(s)"] = notesRes.count!;
      if ((linksRes.count ?? 0) > 0) linked_data["entity link(s)"] = linksRes.count!;

      return handleRemove({
        ctx,
        entity_type: "task",
        entity_id: task_id,
        entity_label: task.title,
        scope: task.scope as "personal" | "org",
        created_by: task.created_by,
        company_id: task.company_id,
        mode,
        resolution,
        linked_data,
        delete_warning: "All notes, entity links, and dependent task references will be permanently removed.",
        before_state: { title: task.title, status: task.status, scope: task.scope },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("tasks")
            .update({ archived_at: new Date().toISOString() })
            .eq("id", task_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive task: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          const { data, error } = await ctx.db
            .from("tasks")
            .update({ deleted_at: new Date().toISOString() })
            .eq("id", task_id)
            .eq("company_id", ctx.companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to delete task: ${error.message}`);
          return data;
        },
      });
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_tasks
  // ──────────────────────────────────────────────────────────
  list_tasks: {
    title: "List Tasks",
    description:
      "List tasks with rich filtering. Omitting scope returns both org tasks and the caller's personal tasks. " +
      "Filter by entity_type + entity_id to see tasks linked to a specific customer, transaction, etc. " +
      "Use assigned_to='@claude' to surface the AI work queue. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("Filter by scope. Omit to return both org and caller's personal tasks."),
      status: z
        .enum(["todo", "in_progress", "blocked", "done"])
        .optional()
        .describe("Filter by status."),
      assigned_to: z
        .string()
        .optional()
        .describe(
          "Filter by assignee. Use a user ID, '@claude', '@gpt', or 'unassigned'."
        ),
      created_by: z.string().optional().describe("Filter by creator user ID."),
      priority: z
        .enum(["low", "medium", "high", "urgent"])
        .optional()
        .describe("Filter by priority."),
      ...tagFilterParams,
      due_before: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Return tasks due on or before this date (YYYY-MM-DD)."),
      due_after: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Return tasks due on or after this date (YYYY-MM-DD)."),
      overdue_only: z
        .boolean()
        .optional()
        .describe("If true, only return tasks past their due date that are not done."),
      entity_type: entityTypeEnum
        .optional()
        .describe("Filter to tasks linked to this entity type."),
      entity_id: z
        .string()
        .optional()
        .describe(
          "Filter to tasks linked to this entity ID. Requires entity_type."
        ),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results. Defaults to 50."),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone string (e.g. 'America/New_York'). When provided, 'today' is " +
          "computed in the user's local timezone rather than UTC. Affects overdue_only filter."
        ),
    }),
    handler: async (ctx: ToolContext, params: {
      scope?: "personal" | "org";
      status?: "todo" | "in_progress" | "blocked" | "done";
      assigned_to?: string;
      created_by?: string;
      priority?: "low" | "medium" | "high" | "urgent";
      tag?: string;
      tags?: string[];
      tag_match?: "all" | "any";
      due_before?: string;
      due_after?: string;
      overdue_only?: boolean;
      entity_type?: EntityType;
      entity_id?: string;
      limit?: number;
      timezone?: string;
    }) => {
      const today = getLocalDateStr(params.timezone);

      // If linking filter, go through task_links
      if (params.entity_type && params.entity_id) {
        const { data: linkRows, error: linkError } = await ctx.db
          .from("task_links")
          .select("task_id")
          .eq("entity_type", params.entity_type)
          .eq("entity_id", params.entity_id)
          .eq("company_id", ctx.companyId);
        if (linkError)
          throw new Error(`Failed to query task links: ${linkError.message}`);

        const taskIds = (linkRows ?? []).map((r: { task_id: string }) => r.task_id);
        if (taskIds.length === 0) {
          const empty: Record<string, unknown> = { tasks: [], count: 0 };
          if (await detectFirstRun(ctx.db, ctx.companyId)) {
            empty._hint = FIRST_RUN_HINT;
          }
          return empty;
        }

        let q = ctx.db
          .from("tasks")
          .select("*")
          .in("id", taskIds)
          .eq("company_id", ctx.companyId)
          .is("archived_at", null)
          .is("deleted_at", null)
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(params.limit ?? 50);

        if (params.status) q = q.eq("status", params.status);
        else q = q.neq("status", "done");

        const { data, error } = await q;
        if (error) throw new Error(`Failed to list tasks: ${error.message}`);
        return { tasks: data ?? [], count: data?.length ?? 0 };
      }

      // Standard query
      let query = ctx.db
        .from("tasks")
        .select("*")
        .eq("company_id", ctx.companyId)
        .is("archived_at", null)
        .is("deleted_at", null)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(params.limit ?? 50);

      // Scope filtering
      if (params.scope === "personal") {
        query = query.eq("scope", "personal").eq("created_by", ctx.userId);
      } else if (params.scope === "org") {
        query = query.eq("scope", "org");
      } else {
        // No scope filter: org tasks + caller's personal tasks
        query = query.or(`scope.eq.org,and(scope.eq.personal,created_by.eq.${ctx.userId})`);
      }

      if (params.status) {
        query = query.eq("status", params.status);
      } else if (!params.overdue_only) {
        query = query.neq("status", "done");
      }

      if (params.assigned_to === "unassigned") {
        query = query.is("assigned_to", null);
      } else if (params.assigned_to) {
        query = query.eq("assigned_to", params.assigned_to);
      }

      if (params.created_by) query = query.eq("created_by", params.created_by);
      if (params.priority) query = query.eq("priority", params.priority);
      const tagList = resolveTagList(params.tag, params.tags);
      if (tagList) {
        query = params.tag_match === "any"
          ? query.overlaps("tags", tagList)
          : query.contains("tags", tagList);
      }
      if (params.due_before) query = query.lte("due_date", params.due_before);
      if (params.due_after) query = query.gte("due_date", params.due_after);

      if (params.overdue_only) {
        query = query
          .lt("due_date", today)
          .not("due_date", "is", null)
          .neq("status", "done");
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list tasks: ${error.message}`);

      // Build tier_3 markdown fallback
      const taskRows = (data ?? []) as {
        title: string;
        status: string;
        priority: string | null;
        due_date: string | null;
        assigned_to: string | null;
      }[];
      const taskTable =
        `| Task | Status | Priority | Due | Assigned |\n` +
        `|------|--------|----------|-----|----------|\n` +
        taskRows
          .slice(0, 20)
          .map(
            (t) =>
              `| ${t.title} | ${t.status} | ${t.priority ?? "-"} | ${t.due_date ?? "-"} | ${t.assigned_to ?? "-"} |`
          )
          .join("\n") +
        (taskRows.length > 20 ? `\n\n_Showing 20 of ${taskRows.length} tasks_` : "");

      const result: Record<string, unknown> = {
        tasks: data ?? [],
        count: data?.length ?? 0,
        render: {
          tier_1: {
            format_hint: "kanban",
            instructions: {
              scope:
                "render the `tasks` array grouped by status (todo, in_progress, " +
                "blocked, done). Show title, priority, due_date, and assignee for " +
                "each task. Cap at 20 tasks total.",
              format:
                "group by status, with each group visually distinct. Apply the " +
                "standard color conventions to due_date (red overdue, amber " +
                "due-today, blue when assigned to @claude or another AI agent).",
              forbidden:
                "do not omit the assignee for AI-assigned tasks; do not display " +
                "more than 20 tasks by default.",
            },
          },
          tier_3: {
            markdown: taskTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
            "For 2 or fewer tasks, inline rendering is fine.",
          ],
        } satisfies Render,
      };

      if (await detectFirstRun(ctx.db, ctx.companyId)) {
        result._hint = FIRST_RUN_HINT;
      }

      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // link_task
  // ──────────────────────────────────────────────────────────
  link_task: {
    title: "Link Task",
    description:
      "Link a task to any FounderOS entity: customer, contact, transaction, contract, memory, or interaction. " +
      "A task can have multiple links. Duplicate links are silently ignored.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
      entity_type: entityTypeEnum.describe(
        "Entity type: customer | contact | interaction | transaction | contract | memory"
      ),
      entity_id: z.string().describe("UUID of the entity to link."),
    }),
    handler: async (ctx: ToolContext, {
      task_id,
      entity_type,
      entity_id,
    }: {
      task_id: string;
      entity_type: EntityType;
      entity_id: string;
    }) => {
      // Verify task belongs to this company before linking
      const { data: task, error: taskErr } = await ctx.db
        .from("tasks")
        .select("id")
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();
      if (taskErr || !task) throw new Error("Task not found or access denied.");
      const { error } = await ctx.db
        .from("task_links")
        .upsert(
          { task_id, entity_type, entity_id, company_id: ctx.companyId },
          { onConflict: "task_id,entity_type,entity_id", ignoreDuplicates: true }
        );
      if (error) throw new Error(`Failed to link task: ${error.message}`);
      return { success: true, task_id, entity_type, entity_id };
    },
  },

  // ──────────────────────────────────────────────────────────
  // unlink_task
  // ──────────────────────────────────────────────────────────
  unlink_task: {
    title: "Unlink Task",
    description: "Remove a specific entity link from a task.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
      entity_type: entityTypeEnum.describe("Entity type to unlink."),
      entity_id: z.string().describe("Entity UUID to unlink."),
    }),
    handler: async (ctx: ToolContext, {
      task_id,
      entity_type,
      entity_id,
    }: {
      task_id: string;
      entity_type: EntityType;
      entity_id: string;
    }) => {
      // Verify task belongs to this company before unlinking
      const { data: task, error: taskErr } = await ctx.db
        .from("tasks")
        .select("id")
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();
      if (taskErr || !task) throw new Error("Task not found or access denied.");
      // Defense in depth: scope the delete by company_id too so a leaked
      // link UUID from another company cannot be used to unlink it.
      const { error } = await ctx.db
        .from("task_links")
        .delete()
        .eq("task_id", task_id)
        .eq("entity_type", entity_type)
        .eq("entity_id", entity_id)
        .eq("company_id", ctx.companyId);
      if (error) throw new Error(`Failed to unlink task: ${error.message}`);
      return { success: true, task_id, entity_type, entity_id };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_entity_tasks
  // ──────────────────────────────────────────────────────────
  list_entity_tasks: {
    title: "List Entity Tasks",
    description: "Get all tasks linked to a specific entity (customer, contact, transaction, etc.).",
    parameters: z.object({
      entity_type: entityTypeEnum.describe("Entity type: customer | contact | interaction | transaction | contract | memory"),
      entity_id: z.string().describe("UUID of the entity."),
      status: z.enum(["todo", "in_progress", "blocked", "done"]).optional()
        .describe("Filter by status. Omit to return all non-done tasks."),
      limit: z.number().min(1).max(100).optional().describe("Max results. Defaults to 50."),
    }),
    handler: async (ctx: ToolContext, {
      entity_type, entity_id, status, limit = 50,
    }: {
      entity_type: EntityType; entity_id: string;
      status?: "todo" | "in_progress" | "blocked" | "done"; limit?: number;
    }) => {
      const { data: linkRows, error: linkError } = await ctx.db
        .from("task_links").select("task_id")
        .eq("entity_type", entity_type).eq("entity_id", entity_id)
        .eq("company_id", ctx.companyId);
      if (linkError) throw new Error(`Failed to query task links: ${linkError.message}`);
      const taskIds = (linkRows ?? []).map((r: { task_id: string }) => r.task_id);
      if (taskIds.length === 0) return { tasks: [], count: 0 };

      // FIX NEW-03: add company_id guard (service role bypasses RLS).
      let query = ctx.db
        .from("tasks")
        .select("*")
        .in("id", taskIds)
        .eq("company_id", ctx.companyId)
        .is("archived_at", null)
        .is("deleted_at", null)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(limit);

      if (status) {
        query = query.eq("status", status);
      } else {
        query = query.neq("status", "done");
      }

      const { data, error } = await query;
      if (error) throw new Error(`Failed to list entity tasks: ${error.message}`);
      return { tasks: data ?? [], count: data?.length ?? 0 };
    },
  },

  // ──────────────────────────────────────────────────────────
  // add_task_note
  // ──────────────────────────────────────────────────────────
  add_task_note: {
    title: "Add Task Note",
    description:
      "Add a progress note to a task without changing its status. " +
      "Useful for logging updates, blockers, or partial progress mid-task.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
      note: z.string().describe("The note content."),
    }),
    handler: async (ctx: ToolContext, { task_id, note }: { task_id: string; note: string }) => {
      // Verify task belongs to this company before inserting a note
      const { data: task, error: taskErr } = await ctx.db
        .from("tasks")
        .select("id")
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .single();
      if (taskErr || !task) throw new Error("Task not found or access denied.");
      const { data, error } = await ctx.db
        .from("task_notes")
        .insert({ task_id, user_id: ctx.userId, note })
        .select()
        .single();
      if (error) throw new Error(`Failed to add note: ${error.message}`);
      return { success: true, note: data };
    },
  },

  // ──────────────────────────────────────────────────────────
  // assign_task
  // ──────────────────────────────────────────────────────────
  assign_task: {
    title: "Assign Task",
    description:
      "Assign or reassign a task to a team member or AI agent. " +
      "Use a FOUNDERS_OS_USER_ID for humans, '@claude' or '@gpt' for AI agents, " +
      "or pass an empty string to unassign. " +
      "A task has exactly one assignee by design - the single accountable owner ('one neck to grab') - so assigning replaces the current owner rather than adding a second. " +
      "For others who are involved, name them in the task description or use @person tags.",
    parameters: z.object({
      task_id: z.string().uuid().describe("Task UUID."),
      assigned_to: z
        .string()
        .describe(
          "User ID, '@claude', '@gpt', or empty string to unassign. Replaces the single accountable owner; one assignee per task by design."
        ),
    }),
    handler: async (ctx: ToolContext, {
      task_id,
      assigned_to,
    }: {
      task_id: string;
      assigned_to: string;
    }) => {
      const { data, error } = await ctx.db
        .from("tasks")
        .update({ assigned_to: assigned_to === "" ? null : assigned_to })
        .eq("id", task_id)
        .eq("company_id", ctx.companyId)
        .select()
        .single();
      if (error) throw new Error(`Failed to assign task: ${error.message}`);
      return { success: true, task: data };
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_task_summary
  // ──────────────────────────────────────────────────────────
  get_task_summary: {
    title: "Get Task Summary",
    description:
      "Dashboard-style summary of the task queue: overdue, due today, upcoming, counts by status, " +
      "by assignee, and a dedicated AI tasks section for tasks assigned to @-prefixed agents. " +
      "Call at session start to orient on what needs attention. " +
      "Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      scope: z
        .enum(["personal", "org"])
        .optional()
        .describe("Limit summary to one scope. Omit for combined view."),
      days: z
        .union([z.literal(7), z.literal(14), z.literal(30)])
        .optional()
        .describe("Upcoming window in days (7, 14, or 30). Defaults to 7."),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone string (e.g. 'America/New_York'). When provided, 'today' is " +
          "computed in the user's local timezone rather than UTC, preventing off-by-one " +
          "date errors for users in western-hemisphere timezones after ~7 pm UTC."
        ),
    }),
    handler: async (ctx: ToolContext, {
      scope,
      days = 7,
      timezone,
    }: {
      scope?: "personal" | "org";
      days?: 7 | 14 | 30;
      timezone?: string;
    }) => {
      // FIX NEW-01: pass caller timezone to getLocalDateStr for both today and windowEnd
      // so the per-call timezone parameter is honoured instead of being silently ignored.
      const today = getLocalDateStr(timezone);
      const windowEnd = getLocalDateStr(timezone, days);

      // scopeOrFilter: the .or() string used when no explicit scope is set.
      // Combines org tasks with the caller's personal tasks.
      const scopeOrFilter = `scope.eq.org,and(scope.eq.personal,created_by.eq.${ctx.userId})`;

      // Each query is built fully inline to keep Supabase types tractable.
      const buildOverdue = () => {
        const q = ctx.db.from("tasks").select("*").eq("company_id", ctx.companyId)
          .is("archived_at", null).is("deleted_at", null);
        const scoped = scope === "personal"
          ? q.eq("scope", "personal").eq("created_by", ctx.userId)
          : scope === "org"
          ? q.eq("scope", "org")
          : q.or(scopeOrFilter);
        return scoped
          .lt("due_date", today)
          .not("due_date", "is", null)
          .neq("status", "done")
          .order("due_date", { ascending: true })
          .limit(20);
      };

      const buildDueToday = () => {
        const q = ctx.db.from("tasks").select("*").eq("company_id", ctx.companyId)
          .is("archived_at", null).is("deleted_at", null);
        const scoped = scope === "personal"
          ? q.eq("scope", "personal").eq("created_by", ctx.userId)
          : scope === "org"
          ? q.eq("scope", "org")
          : q.or(scopeOrFilter);
        return scoped.eq("due_date", today).neq("status", "done");
      };

      const buildUpcoming = () => {
        const q = ctx.db.from("tasks").select("*").eq("company_id", ctx.companyId)
          .is("archived_at", null).is("deleted_at", null);
        const scoped = scope === "personal"
          ? q.eq("scope", "personal").eq("created_by", ctx.userId)
          : scope === "org"
          ? q.eq("scope", "org")
          : q.or(scopeOrFilter);
        return scoped
          .gt("due_date", today)
          .lte("due_date", windowEnd)
          .neq("status", "done")
          .order("due_date", { ascending: true })
          .limit(20);
      };

      const buildOpen = () => {
        const q = ctx.db
          .from("tasks")
          .select("status, assigned_to, priority, blocked_by_task_id")
          .eq("company_id", ctx.companyId)
          .is("archived_at", null).is("deleted_at", null);
        const scoped = scope === "personal"
          ? q.eq("scope", "personal").eq("created_by", ctx.userId)
          : scope === "org"
          ? q.eq("scope", "org")
          : q.or(scopeOrFilter);
        return scoped.neq("status", "done");
      };

      const buildAiTasks = () => {
        const q = ctx.db.from("tasks").select("*").eq("company_id", ctx.companyId)
          .is("archived_at", null).is("deleted_at", null);
        const scoped = scope === "personal"
          ? q.eq("scope", "personal").eq("created_by", ctx.userId)
          : scope === "org"
          ? q.eq("scope", "org")
          : q.or(scopeOrFilter);
        return scoped
          .like("assigned_to", "@%")
          .neq("status", "done")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(20);
      };

      const [
        overdueRes,
        dueTodayRes,
        upcomingRes,
        openRes,
        aiTasksRes,
      ] = await Promise.all([
        buildOverdue(),
        buildDueToday(),
        buildUpcoming(),
        buildOpen(),
        buildAiTasks(),
      ]);

      // Build counts from open tasks
      const statusCounts: Record<string, number> = {};
      const assigneeCounts: Record<string, number> = {};
      const priorityCounts: Record<string, number> = {};
      let blocked_by_dependency_count = 0;

      if (openRes.data) {
        for (const row of openRes.data as {
          status: string;
          assigned_to: string | null;
          priority: string;
          blocked_by_task_id: string | null;
        }[]) {
          statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
          const assignee = row.assigned_to ?? "unassigned";
          assigneeCounts[assignee] = (assigneeCounts[assignee] ?? 0) + 1;
          priorityCounts[row.priority] = (priorityCounts[row.priority] ?? 0) + 1;
          if (row.blocked_by_task_id) blocked_by_dependency_count++;
        }
      }

      // Build tier_3 markdown fallback with pre-rendered markdown table
      const overdueList = (overdueRes.data ?? []) as { title: string; due_date?: string; priority?: string }[];
      const dueTodayList = (dueTodayRes.data ?? []) as { title: string; priority?: string }[];
      const upcomingList = (upcomingRes.data ?? []) as { title: string; due_date?: string; priority?: string }[];

      const attentionItems = [
        ...overdueList.map(t => `| ${t.title} | Overdue${t.due_date ? ` (${t.due_date})` : ""} | ${t.priority ?? "-"} |`),
        ...dueTodayList.map(t => `| ${t.title} | Due today | ${t.priority ?? "-"} |`),
        ...upcomingList.slice(0, 5).map(t => `| ${t.title} | ${t.due_date ?? "no date"} | ${t.priority ?? "-"} |`),
      ];

      const markdownTable = attentionItems.length > 0
        ? "| Task | Status | Priority |\n|------|--------|----------|\n" + attentionItems.join("\n")
        : "No overdue, due-today, or upcoming tasks.";

      const result: Record<string, unknown> = {
        today,
        upcoming_window_days: days,
        overdue: overdueRes.data ?? [],
        overdue_count: overdueRes.data?.length ?? 0,
        due_today: dueTodayRes.data ?? [],
        due_today_count: dueTodayRes.data?.length ?? 0,
        upcoming: upcomingRes.data ?? [],
        upcoming_count: upcomingRes.data?.length ?? 0,
        open_by_status: statusCounts,
        open_by_assignee: assigneeCounts,
        open_by_priority: priorityCounts,
        blocked_by_dependency_count,
        ai_tasks: {
          description: "Tasks assigned to AI agents (@claude, @gpt, etc.)",
          tasks: aiTasksRes.data ?? [],
          count: aiTasksRes.data?.length ?? 0,
        },
        render: {
          tier_1: {
            format_hint: "status_groups",
            instructions: {
              scope:
                "render the overdue, due_today, and upcoming groups in that " +
                "order. Show the four headline counts (overdue_count, " +
                "due_today_count, upcoming_count, blocked_by_dependency_count) " +
                "above the lists. Include the ai_tasks section as a separate group.",
              format:
                "headline counts at the top, then grouped task lists beneath " +
                "each section header. Apply the standard color conventions " +
                "(red for overdue, amber for due_today, neutral for upcoming, " +
                "blue for @claude or AI-assigned tasks).",
              forbidden:
                "do not reorder the groups (overdue first); do not omit ai_tasks " +
                "when count > 0; do not show counts without the per-item lists.",
            },
          },
          tier_3: {
            markdown: markdownTable,
          },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
          ],
        } satisfies Render,
      };

      if (await detectFirstRun(ctx.db, ctx.companyId)) {
        result.first_run = true;
        result._hint = FIRST_RUN_HINT;
      }

      return result;
    },
  },
};

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, taskTools, ctx);
}
