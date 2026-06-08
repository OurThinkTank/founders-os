// ============================================================
// Founders OS - Project Registry Tools (v1)
// ============================================================
// Projects are named entities with lifecycle status. Each project
// owns a #-prefixed tag in the tag_registry. The tag is the sole
// relationship between a project and its tasks/customers in v1
// (no project_links table).
//
// This gives validateTags a real data source for # prefix detection
// instead of the hyphen/digit heuristic.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { conflict } from "../conflict.js";
import { toSlug } from "../tags/index.js";
import { handleRemove, removeResolutionParams, type RemoveMode, type RemoveResolution } from "../remove.js";
import type { Render } from "../../types/render.js";
import type { ToolContext } from "../../types/context.js";

// Note: legacy helpers used inside contextual handlers below:
//   - toSlug() is pure
//   - handleRemove() takes its own client/companyId args from the caller
//   - The lint only forbids createServiceClient/getCompanyId/getUserId
//     directly inside contextual handler bodies; indirect helpers are fine.

const projectStatusEnum = z.enum(["active", "paused", "completed", "archived"]);

export const projectTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // create_project
  // ──────────────────────────────────────────────────────────
  create_project: {
    title: "Create Project",
    description:
      "Register a new project. Auto-creates a #-prefixed tag in the tag registry. " +
      "Returns a conflict if a project with the same slug already exists. " +
      "If the user mentions starting or working on a project that doesn't exist " +
      "in the registry, suggest creating it. Example triggers: 'I'm starting a new " +
      "project called X', 'working on project X', 'let's kick off X.' Always confirm " +
      "before creating.",
    parameters: z.object({
      name: z
        .string()
        .describe("Display name for the project (e.g. 'Founders OS', 'Series A')."),
      description: z
        .string()
        .optional()
        .describe("What this project is about."),
      status: projectStatusEnum
        .optional()
        .describe("Project status. Defaults to 'active'."),
    }),
    handler: async (ctx: ToolContext, {
        name,
        description,
        status,
      }: {
        name: string;
        description?: string;
        status?: "active" | "paused" | "completed" | "archived";
      }
    ) => {
      const companyId = ctx.companyId;
      const userId = ctx.userId;
      const slug = toSlug(name);
      const tagName = `#${slug}`;

      if (!slug) throw new Error("Project name produces an empty slug. Use a name with letters or digits.");

      // Check for existing project with same slug
      const { data: existing } = await ctx.db
        .from("projects")
        .select("id, name, status")
        .eq("company_id", companyId)
        .eq("slug", slug)
        .is("deleted_at", null)
        .maybeSingle();

      if (existing) {
        throw new Error(
          `Project "${existing.name}" (${existing.status}) already exists with slug "${slug}". ` +
          `Use update_project to change it.`
        );
      }

      // Create the project
      const { data: project, error: projErr } = await ctx.db
        .from("projects")
        .insert({
          name: name.trim(),
          slug,
          tag_name: tagName,
          status: status ?? "active",
          description: description ?? null,
          company_id: companyId,
          created_by: userId,
        })
        .select()
        .single();

      if (projErr) throw new Error(`Failed to create project: ${projErr.message}`);

      // Auto-create the # tag in the registry (ignore if it already exists)
      const { error: tagErr } = await ctx.db
        .from("tag_registry")
        .insert({
          name: tagName,
          slug,
          color: null,
          description: `Project: ${name.trim()}`,
          scope: "org",
          company_id: companyId,
          created_by: userId,
        });

      const tagCreated = !tagErr;
      const tagExisted = tagErr?.code === "23505";

      if (tagErr && !tagExisted) {
        // Non-duplicate error - project was created but tag failed
        return {
          success: true,
          project,
          tag_warning: `Project created but tag "${tagName}" failed: ${tagErr.message}. Create it manually with create_tag.`,
        };
      }

      // Check for existing tasks/customers already using this tag
      const [taskRes, custRes] = await Promise.all([
        ctx.db
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tagName])
          .is("deleted_at", null),
        ctx.db
          .from("customers")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .contains("tags", [tagName])
          .is("deleted_at", null),
      ]);

      const existingTaskCount = taskRes.count ?? 0;
      const existingCustomerCount = custRes.count ?? 0;

      // Check for customer name match (awareness, not linking)
      const { data: matchingCustomers } = await ctx.db
        .from("customers")
        .select("id, organization_name, customer_phase")
        .eq("company_id", companyId)
        .ilike("organization_name", `%${name.trim()}%`)
        .is("deleted_at", null)
        .limit(3);

      const result: Record<string, unknown> = {
        success: true,
        project,
        tag: {
          name: tagName,
          created: tagCreated,
          already_existed: tagExisted,
        },
      };

      if (existingTaskCount > 0 || existingCustomerCount > 0) {
        result.existing_usage = {
          tasks: existingTaskCount,
          customers: existingCustomerCount,
          note: `Found ${existingTaskCount} task(s) and ${existingCustomerCount} customer(s) already using the "${tagName}" tag. They are now associated with this project.`,
        };
      }

      if (matchingCustomers && matchingCustomers.length > 0) {
        result.related_customers = {
          matches: matchingCustomers,
          note: `Found customer(s) with a similar name. You can tag them with "${tagName}" to associate them with this project.`,
        };
      }

      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_projects
  // ──────────────────────────────────────────────────────────
  list_projects: {
    title: "List Projects",
    description:
      "List registered projects. Defaults to active projects only. " +
      "Returns task counts per project (queried by tag). " +
      "Also flags any #-prefixed tags in the registry that don't have a corresponding project record.",
    parameters: z.object({
      status: projectStatusEnum
        .optional()
        .describe("Filter by status. Omit to return active projects only."),
      include_all: z
        .boolean()
        .optional()
        .describe("Set true to return projects in all statuses."),
    }),
    handler: async (ctx: ToolContext, {
        status,
        include_all,
      }: {
        status?: "active" | "paused" | "completed" | "archived";
        include_all?: boolean;
      }
    ) => {
      const companyId = ctx.companyId;

      let query = ctx.db
        .from("projects")
        .select("*")
        .eq("company_id", companyId)
        .order("name", { ascending: true });

      if (!include_all) {
        query = query.eq("status", status ?? "active");
      } else if (status) {
        query = query.eq("status", status);
      }
      query = query.is("deleted_at", null);

      const { data: projects, error } = await query;
      if (error) throw new Error(`Failed to list projects: ${error.message}`);

      // For each project, get task counts by status via tag
      const enriched = await Promise.all(
        (projects ?? []).map(async (p: Record<string, unknown>) => {
          const tagName = p.tag_name as string;
          if (!tagName) return { ...p, task_counts: null };

          const [todoRes, ipRes, blockedRes, doneRes] = await Promise.all([
            ctx.db
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .eq("status", "todo")
              .contains("tags", [tagName])
              .is("deleted_at", null),
            ctx.db
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .eq("status", "in_progress")
              .contains("tags", [tagName])
              .is("deleted_at", null),
            ctx.db
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .eq("status", "blocked")
              .contains("tags", [tagName])
              .is("deleted_at", null),
            ctx.db
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .eq("status", "done")
              .contains("tags", [tagName])
              .is("deleted_at", null),
          ]);

          return {
            ...p,
            task_counts: {
              todo: todoRes.count ?? 0,
              in_progress: ipRes.count ?? 0,
              blocked: blockedRes.count ?? 0,
              done: doneRes.count ?? 0,
              total: (todoRes.count ?? 0) + (ipRes.count ?? 0) + (blockedRes.count ?? 0) + (doneRes.count ?? 0),
            },
          };
        })
      );

      // Check for orphaned # tags (tags with # prefix but no project)
      const { data: allTags } = await ctx.db
        .from("tag_registry")
        .select("name, slug")
        .eq("company_id", companyId)
        .is("deleted_at", null);

      const projectSlugs = new Set((projects ?? []).map((p: Record<string, unknown>) => p.slug as string));

      const orphanedTags = (allTags ?? [])
        .filter((t: { name: string; slug: string }) =>
          t.name.startsWith("#") && !projectSlugs.has(t.slug)
        )
        .map((t: { name: string }) => t.name);

      const result: Record<string, unknown> = {
        projects: enriched,
        count: enriched.length,
      };

      if (orphanedTags.length > 0) {
        result.orphaned_project_tags = {
          tags: orphanedTags,
          note: `Found ${orphanedTags.length} tag(s) with # prefix that don't have a project record. Want me to create project records for them?`,
        };
      }

      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // get_project
  // ──────────────────────────────────────────────────────────
  get_project: {
    title: "Get Project",
    description:
      "Get a full project card: project details, associated tag, and all tasks/customers " +
      "carrying the project's tag. Tasks are grouped by status with recent items shown.",
    parameters: z.object({
      project_id: z.string().uuid().describe("Project UUID."),
    }),
    handler: async (ctx: ToolContext, { project_id }: { project_id: string }) => {
      const companyId = ctx.companyId;

      // Fetch project
      const { data: project, error: projErr } = await ctx.db
        .from("projects")
        .select("*")
        .eq("id", project_id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .single();

      if (projErr) throw new Error(`Project not found: ${projErr.message}`);

      const tagName = project.tag_name as string;

      if (!tagName) {
        return { project, tasks: null, customers: null };
      }

      // Fetch tasks by tag, grouped by status
      const [todoTasks, ipTasks, blockedTasks, doneTasks] = await Promise.all([
        ctx.db
          .from("tasks")
          .select("id, title, priority, due_date, assigned_to, created_at")
          .eq("company_id", companyId)
          .eq("status", "todo")
          .contains("tags", [tagName])
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(10),
        ctx.db
          .from("tasks")
          .select("id, title, priority, due_date, assigned_to, created_at")
          .eq("company_id", companyId)
          .eq("status", "in_progress")
          .contains("tags", [tagName])
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(10),
        ctx.db
          .from("tasks")
          .select("id, title, priority, due_date, assigned_to, blocked_reason, created_at")
          .eq("company_id", companyId)
          .eq("status", "blocked")
          .contains("tags", [tagName])
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(10),
        ctx.db
          .from("tasks")
          .select("id, title, completed_at")
          .eq("company_id", companyId)
          .eq("status", "done")
          .contains("tags", [tagName])
          .is("deleted_at", null)
          .order("completed_at", { ascending: false })
          .limit(5),
      ]);

      // Count totals (the queries above are limited)
      const [todoCount, ipCount, blockedCount, doneCount] = await Promise.all([
        ctx.db.from("tasks").select("id", { count: "exact", head: true })
          .eq("company_id", companyId).eq("status", "todo").contains("tags", [tagName]).is("deleted_at", null),
        ctx.db.from("tasks").select("id", { count: "exact", head: true })
          .eq("company_id", companyId).eq("status", "in_progress").contains("tags", [tagName]).is("deleted_at", null),
        ctx.db.from("tasks").select("id", { count: "exact", head: true })
          .eq("company_id", companyId).eq("status", "blocked").contains("tags", [tagName]).is("deleted_at", null),
        ctx.db.from("tasks").select("id", { count: "exact", head: true })
          .eq("company_id", companyId).eq("status", "done").contains("tags", [tagName]).is("deleted_at", null),
      ]);

      // Fetch customers by tag
      const { data: customers } = await ctx.db
        .from("customers")
        .select("id, organization_name, customer_type, customer_phase")
        .eq("company_id", companyId)
        .contains("tags", [tagName])
        .is("deleted_at", null);

      // Fetch tag info from registry
      const { data: tagInfo } = await ctx.db
        .from("tag_registry")
        .select("id, name, slug, color, description")
        .eq("company_id", companyId)
        .eq("slug", project.slug)
        .is("deleted_at", null)
        .maybeSingle();

      return {
        project,
        tag: tagInfo,
        tasks: {
          counts: {
            todo: todoCount.count ?? 0,
            in_progress: ipCount.count ?? 0,
            blocked: blockedCount.count ?? 0,
            done: doneCount.count ?? 0,
            open: (todoCount.count ?? 0) + (ipCount.count ?? 0) + (blockedCount.count ?? 0),
            total: (todoCount.count ?? 0) + (ipCount.count ?? 0) + (blockedCount.count ?? 0) + (doneCount.count ?? 0),
          },
          todo: todoTasks.data ?? [],
          in_progress: ipTasks.data ?? [],
          blocked: blockedTasks.data ?? [],
          recently_done: doneTasks.data ?? [],
        },
        customers: customers ?? [],
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // update_project
  // ──────────────────────────────────────────────────────────
  update_project: {
    title: "Update Project",
    description:
      "Update a project's name, description, or status. Name changes trigger a tag rename " +
      "with propagation conflict if the tag is in use. Status change to 'completed' or 'archived' " +
      "triggers a conflict if tasks with the project's tag are still open.",
    parameters: z.object({
      project_id: z.string().uuid().describe("Project UUID."),
      name: z.string().optional().describe("New display name."),
      description: z.string().optional().describe("New description."),
      status: projectStatusEnum.optional().describe("New status."),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Resolution for the open-tasks guard: 'confirm' archives/completes anyway, 'cancel' aborts."),
      confirm_archive: z
        .boolean()
        .optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Proceed with completing/archiving despite open tasks."),
      cascade: z
        .boolean()
        .optional()
        .describe("On rename: true also renames the tag on all tasks/customers; false updates only the registry."),
      propagate_rename: z
        .boolean()
        .optional()
        .describe("Deprecated: use `cascade`. Propagate or skip the tag rename on tasks/customers."),
    }),
    handler: async (ctx: ToolContext, {
        project_id,
        name,
        description,
        status,
        confirm_archive,
        propagate_rename,
        resolution,
        cascade,
      }: {
        project_id: string;
        name?: string;
        description?: string;
        status?: "active" | "paused" | "completed" | "archived";
        confirm_archive?: boolean;
        propagate_rename?: boolean;
        resolution?: "confirm" | "cancel";
        cascade?: boolean;
      }
    ) => {
      if (resolution === "cancel") {
        return { success: false, message: "Cancelled. The project was not updated." };
      }
      const proceedArchive = confirm_archive === true || resolution === "confirm";
      const doCascade = cascade ?? propagate_rename;
      const companyId = ctx.companyId;

      // Fetch current project
      const { data: current, error: fetchErr } = await ctx.db
        .from("projects")
        .select("*")
        .eq("id", project_id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Project not found: ${fetchErr.message}`);

      // If status is being set to completed/archived, check for open tasks
      if (
        (status === "completed" || status === "archived") &&
        !proceedArchive &&
        current.tag_name
      ) {
        const { count } = await ctx.db
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .in("status", ["todo", "in_progress", "blocked"])
          .contains("tags", [current.tag_name])
          .is("deleted_at", null);

        if ((count ?? 0) > 0) {
          return conflict(
            "destructive_action",
            `Project "${current.name}" still has ${count} open task(s). ${status === "archived" ? "Archiving" : "Completing"} it won't close them.`,
            [
              {
                key: "proceed",
                label: `${status === "archived" ? "Archive" : "Complete"} anyway`,
                value: { project_id, status, resolution: "confirm" },
              },
              { key: "cancel", label: "Cancel", value: { resolution: "cancel" } },
            ],
            { open_task_count: count }
          );
        }
      }

      // If name is changing, handle tag rename
      let renameResult: Record<string, unknown> | null = null;
      if (name && name.trim() !== current.name) {
        const newSlug = toSlug(name);
        const newTagName = `#${newSlug}`;
        const oldTagName = current.tag_name as string;

        // Check if new slug conflicts with another project
        const { data: slugConflict } = await ctx.db
          .from("projects")
          .select("id, name")
          .eq("company_id", companyId)
          .eq("slug", newSlug)
          .neq("id", project_id)
          .is("deleted_at", null)
          .maybeSingle();

        if (slugConflict) {
          throw new Error(
            `Slug "${newSlug}" is already used by project "${slugConflict.name}". Choose a different name.`
          );
        }

        // Find the tag in the registry and rename it
        if (oldTagName) {
          const { data: oldTag } = await ctx.db
            .from("tag_registry")
            .select("id")
            .eq("company_id", companyId)
            .eq("slug", current.slug)
            .is("deleted_at", null)
            .maybeSingle();

          if (oldTag) {
            // Check usage and ask about propagation if not already decided
            if (doCascade === undefined) {
              const [taskRes, custRes] = await Promise.all([
                ctx.db
                  .from("tasks")
                  .select("id", { count: "exact", head: true })
                  .eq("company_id", companyId)
                  .contains("tags", [oldTagName])
                  .is("deleted_at", null),
                ctx.db
                  .from("customers")
                  .select("id", { count: "exact", head: true })
                  .eq("company_id", companyId)
                  .contains("tags", [oldTagName])
                  .is("deleted_at", null),
              ]);

              const taskCount = taskRes.count ?? 0;
              const custCount = custRes.count ?? 0;

              if (taskCount > 0 || custCount > 0) {
                return conflict(
                  "silent_default",
                  `Renaming project "${current.name}" to "${name}" will also rename tag "${oldTagName}" to "${newTagName}". ` +
                  `${taskCount} task(s) and ${custCount} customer(s) use this tag. Propagate the rename?`,
                  [
                    {
                      key: "propagate",
                      label: "Yes, update everywhere",
                      value: { project_id, name, description, status, cascade: true },
                    },
                    {
                      key: "registry_only",
                      label: "No, just rename the project and tag registry",
                      value: { project_id, name, description, status, cascade: false },
                    },
                  ],
                  { tag_name: oldTagName, task_count: taskCount, customer_count: custCount }
                );
              }
            }

            // Perform tag rename
            const { error: tagUpdateErr } = await ctx.db
              .from("tag_registry")
              .update({ name: newTagName, slug: newSlug, description: `Project: ${name.trim()}` })
              .eq("id", oldTag.id)
              .eq("company_id", companyId);

            if (tagUpdateErr) {
              renameResult = { tag_rename_error: tagUpdateErr.message };
            } else if (doCascade) {
              // Propagate to tasks and customers
              const [taskRpc, custRpc] = await Promise.all([
                ctx.db.rpc("rename_tag_in_tasks", {
                  p_company_id: companyId,
                  p_old_name: oldTagName,
                  p_new_name: newTagName,
                }),
                ctx.db.rpc("rename_tag_in_customers", {
                  p_company_id: companyId,
                  p_old_name: oldTagName,
                  p_new_name: newTagName,
                }),
              ]);

              renameResult = {
                tag_renamed: true,
                propagated: {
                  tasks: taskRpc.data ?? 0,
                  customers: custRpc.data ?? 0,
                },
              };

              if (taskRpc.error || custRpc.error) {
                renameResult.propagation_error =
                  [taskRpc.error?.message, custRpc.error?.message].filter(Boolean).join("; ");
              }
            } else {
              renameResult = { tag_renamed: true, propagated: false };
            }
          }
        }
      }

      // Build update payload
      const updates: Record<string, unknown> = {};
      if (name) {
        updates.name = name.trim();
        updates.slug = toSlug(name);
        updates.tag_name = `#${toSlug(name)}`;
      }
      if (description !== undefined) updates.description = description;
      if (status) updates.status = status;

      if (Object.keys(updates).length === 0) {
        throw new Error("Nothing to update. Provide at least one of: name, description, status.");
      }

      const { data: updated, error: updateErr } = await ctx.db
        .from("projects")
        .update(updates)
        .eq("id", project_id)
        .eq("company_id", companyId)
        .select()
        .single();

      if (updateErr) throw new Error(`Failed to update project: ${updateErr.message}`);

      const result: Record<string, unknown> = { success: true, project: updated };
      if (renameResult) {
        result.tag_rename = renameResult;

        // If the project tag rename produced a propagation_error, attach an
        // incident render block so the partial failure surfaces clearly.
        const propagationError = (renameResult as Record<string, unknown>)
          .propagation_error;
        if (typeof propagationError === "string") {
          const incidentMarkdown =
            `**Project renamed with issues**\n\n` +
            `The project record was updated, but the renamed tag did not reach all ` +
            `linked tasks and customers. They still show the old tag name.\n\n` +
            `**What happened:** ${propagationError}\n\n` +
            `You can retry the rename or update the missed items manually.`;

          const render: Render = {
            tier_1: {
              format_hint: "incident",
              instructions: {
                scope:
                  "show that the project rename succeeded but the tag did not " +
                  "reach all linked items. Include the error detail.",
                format:
                  "amber header per the standard color conventions; the error " +
                  "detail appears beneath the success summary as plain prose.",
                forbidden:
                  "do not present this as a clean success; do not paraphrase " +
                  "the error detail (the user needs the literal message to act on it).",
              },
            },
            tier_3: {
              markdown: incidentMarkdown,
            },
            do_not: [
              "Do not invent new color meanings; use the standard color conventions.",
            ],
          };
          result.render = render;
        }
      }

      return result;
    },
  },

  // ──────────────────────────────────────────────────────────
  // remove_project
  // ──────────────────────────────────────────────────────────
  remove_project: {
    title: "Remove Project",
    description:
      "Remove a project by archiving (sets status to 'archived', recoverable) or permanently deleting. " +
      "On first call, returns a conflict with ARCHIVE / DELETE / CANCEL options. " +
      "Pass mode after the user decides. The project's tag is kept in the registry on archive. " +
      "On delete, the project record and its registry tag are removed but tasks/customers keep " +
      "the tag string in their arrays (orphaned). Run history referencing this project is preserved.",
    parameters: z.object({
      project_id: z.string().uuid().describe("Project UUID to remove."),
      ...removeResolutionParams,
    }),
    handler: async (ctx: ToolContext, {
        project_id,
        mode,
        resolution,
      }: {
        project_id: string;
        mode?: RemoveMode;
        resolution?: RemoveResolution;
      }
    ) => {
      const companyId = ctx.companyId;

      const { data: project, error: fetchErr } = await ctx.db
        .from("projects")
        .select("*")
        .eq("id", project_id)
        .eq("company_id", companyId)
        .is("deleted_at", null)
        .single();

      if (fetchErr) throw new Error(`Project not found: ${fetchErr.message}`);

      const tagName = project.tag_name as string;

      // Count linked data
      const [taskRes, custRes] = await Promise.all([
        tagName
          ? ctx.db
              .from("tasks")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .in("status", ["todo", "in_progress", "blocked"])
              .contains("tags", [tagName])
              .is("deleted_at", null)
          : Promise.resolve({ count: 0 }),
        tagName
          ? ctx.db
              .from("customers")
              .select("id", { count: "exact", head: true })
              .eq("company_id", companyId)
              .contains("tags", [tagName])
              .is("deleted_at", null)
          : Promise.resolve({ count: 0 }),
      ]);

      return handleRemove({
        ctx,
        entity_type: "project",
        entity_id: project_id,
        entity_label: project.name as string,
        scope: "org",
        company_id: companyId,
        mode,
        resolution,
        linked_data: {
          open_tasks: (taskRes.count ?? 0),
          tagged_customers: (custRes.count ?? 0),
        },
        delete_warning:
          "The project record and its registry tag will be deleted. " +
          "Tasks and customers keep the tag string but it will be orphaned.",
        before_state: {
          name: project.name,
          slug: project.slug,
          status: project.status,
          tag_name: project.tag_name,
          description: project.description,
        },
        archiveFn: async () => {
          const { data, error } = await ctx.db
            .from("projects")
            .update({ status: "archived" })
            .eq("id", project_id)
            .eq("company_id", companyId)
            .select()
            .single();
          if (error) throw new Error(`Failed to archive project: ${error.message}`);
          return data;
        },
        deleteFn: async () => {
          const now = new Date().toISOString();
          // Soft-delete the project record
          const { data, error: projErr } = await ctx.db
            .from("projects")
            .update({ deleted_at: now })
            .eq("id", project_id)
            .eq("company_id", companyId)
            .select()
            .single();
          if (projErr) throw new Error(`Failed to delete project: ${projErr.message}`);

          // Also soft-delete the associated tag from the registry
          if (tagName) {
            await ctx.db
              .from("tag_registry")
              .update({ deleted_at: now })
              .eq("company_id", companyId)
              .eq("slug", project.slug);
          }
          return data;
        },
      });
    },
  },
};

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, projectTools, ctx);
}
