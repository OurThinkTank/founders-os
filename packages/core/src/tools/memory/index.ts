// ============================================================
// Founders OS — Memory Tools
// ============================================================
// 5 tools: memory_store, memory_recall, memory_forget,
//          memory_update, memory_summarize_and_store
//
// User identity: FOUNDERS_OS_USER_ID env var (defaults to the
// sample placeholder "foundersuser1" when unset; see utils/identity.ts).
// Memory scope:
//   org      — visible to all team members (user_id stored as 'org')
//   personal — visible only to the caller (user_id stored as FOUNDERS_OS_USER_ID)
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embed } from "./embed.js";
import { registerToolMap, type ToolMap } from "../register.js";
import { conflict } from "../conflict.js";
import { writeAuditLog } from "../audit.js";
import type { ToolContext } from "../../types/context.js";

// Tenant scoping: every read, write, and the match_memories RPC scope
// by company_id (ctx.companyId) as the outer tenant boundary, on top
// of the user_id/scope (org sentinel vs caller) dimension. Added
// 2026-05-30 (migration 037, Phase 0d / N1). The RPC's company_id_filter
// arg is additive and defaults to NULL server-side, so a rolling deploy
// where old code still calls without it keeps working.

// ── Related-memory detection ─────────────────────────────────
// Before inserting, check if a semantically similar memory
// already exists in the same scope+project. Returns a conflict
// response if a match scores above the threshold, giving the
// user the option to update the existing memory instead of
// creating a near-duplicate.

const DEDUP_THRESHOLD = 0.75;

interface DedupMatch {
  id: string;
  content: string;
  score: number;
  created_at: string;
}

async function checkForDuplicate(
  supabase: SupabaseClient,
  embedding: number[],
  userId: string,
  companyId: string,
  scope: "org" | "personal",
  project: string | null,
  newContent: string
): Promise<ReturnType<typeof conflict> | null> {
  const scopeFilter = scope === "org" ? "org" : "personal";

  const { data, error } = await supabase.rpc("match_memories", {
    query_embedding: embedding,
    user_id_filter: userId,
    company_id_filter: companyId,
    scope_filter: scopeFilter,
    project_filter: project,
    match_count: 1,
  });

  if (error || !data || data.length === 0) return null;

  const top = data[0] as DedupMatch;
  if (top.score < DEDUP_THRESHOLD) return null;

  const preview = top.content.length > 300
    ? top.content.slice(0, 300) + "..."
    : top.content;

  const newPreview = newContent.length > 300
    ? newContent.slice(0, 300) + "..."
    : newContent;

  return conflict(
    "ambiguous_input",
    `I found a related memory (${Math.round(top.score * 100)}% similar). ` +
    `Want to update it, store both, or skip?`,
    [
      {
        key: "update_existing",
        label: "Update the existing memory with this new version",
        value: { update_memory_id: top.id },
      },
      {
        key: "store_anyway",
        label: "Store as a separate memory (keep both)",
        value: { resolution: "confirm" },
      },
      {
        key: "skip",
        label: "Skip - the existing memory is sufficient",
        value: { resolution: "cancel" },
      },
    ],
    {
      existing_memory_id: top.id,
      existing_memory_preview: preview,
      new_memory_preview: newPreview,
      similarity_score: top.score,
    }
  );
}

export const memoryTools: ToolMap = {
  memory_store: {
    title: "Memory Store",
    description:
      "Store a specific memory entry. Use scope='org' for team-wide visibility, " +
      "'personal' for caller only. Call this whenever you learn something worth " +
      "remembering across sessions.",
    parameters: z.object({
      content: z.string().max(20000, "Memory content exceeds 20,000 characters. Split into multiple memories or summarize before storing.").describe("The information to remember (max 20,000 characters)."),
      scope: z
        .enum(["org", "personal"])
        .describe("'org' for team-wide visibility, 'personal' for caller only."),
      project: z
        .string()
        .optional()
        .describe("Optional project tag (e.g. 'founders-os', 'client-acme')."),
      source_tool: z
        .string()
        .optional()
        .describe("Optional label for the originating tool or surface."),
      kind: z
        .string()
        .optional()
        .describe(
          "Optional classifier stored in metadata.kind (e.g. 'checkpoint', 'decision', 'fact'). " +
          "Used by get_project_history to build a typed timeline."
        ),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Conflict resolution after a near-duplicate is found: 'confirm' stores anyway, 'cancel' skips."),
      force: z
        .boolean()
        .optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Set true to skip near-duplicate detection."),
    }),
    handler: async (ctx: ToolContext, { content, scope, project, source_tool, kind, force, resolution }: {
      content: string;
      scope: "org" | "personal";
      project?: string;
      source_tool?: string;
      kind?: string;
      force?: boolean;
      resolution?: "confirm" | "cancel";
    }) => {
      if (resolution === "cancel") {
        return { success: false, message: "Skipped. No memory was stored." };
      }
      const skipDedup = force === true || resolution === "confirm";
      const callerUserId = ctx.userId;
      const userId = scope === "org" ? "org" : callerUserId;
      const embedding = await embed(ctx, content);

      // Check for near-duplicate before inserting
      if (!skipDedup) {
        const dupConflict = await checkForDuplicate(
          ctx.db, embedding, callerUserId, ctx.companyId, scope, project ?? null, content
        );
        if (dupConflict) return dupConflict;
      }

      const { data, error } = await ctx.db
        .from("memories")
        .insert({
          user_id: userId,
          company_id: ctx.companyId,
          created_by: callerUserId,
          scope,
          project: project ?? null,
          content,
          embedding: JSON.stringify(embedding),
          source_tool: source_tool ?? null,
          ...(kind ? { metadata: { kind } } : {}),
        })
        .select("id, user_id, scope, project, content, created_at")
        .single();

      if (error) throw new Error(`Failed to store memory: ${error.message}`);

      // Only audit org-scoped memories — team-visible knowledge changes are worth tracking
      if (scope === "org") {
        const memData = data as { id?: string } | null;
        await writeAuditLog(ctx, {
          action: "memory_store",
          entity_type: "memory",
          entity_id: memData?.id ?? "unknown",
          after_state: {
            scope,
            project: project ?? null,
            content_excerpt: content.length > 200 ? content.slice(0, 200) + "..." : content,
          },
        });
      }

      return data;
    },
  },

  memory_recall: {
    title: "Memory Recall",
    description:
      "Semantically search stored memories and return the most relevant results. " +
      "Call at the start of any project session to load prior context.",
    parameters: z.object({
      query: z.string().describe("Natural language description of what to recall."),
      scope: z
        .enum(["org", "personal", "both"])
        .optional()
        .describe(
          "Scope to search: 'personal' for your own memories, 'org' for shared team memories, " +
          "'both' (or omit) for all accessible memories."
        ),
      project: z.string().optional().describe("Optional project filter."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results to return (default 10)."),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Minimum similarity score (0-1) to include in results (default 0.35). " +
          "Increase to filter noise, decrease to cast a wider net."
        ),
      source_tool: z
        .string()
        .optional()
        .describe(
          "Filter by originating tool (e.g. 'complete_task', 'memory_summarize_and_store', 'cowork'). " +
          "Only memories created by this tool are returned."
        ),
      from_date: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return memories created on or after this date (e.g. '2026-04-01T00:00:00Z')."),
      to_date: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp. Only return memories created on or before this date (e.g. '2026-05-01T00:00:00Z')."),
      created_after: z
        .string()
        .optional()
        .describe("Deprecated: use `from_date`."),
      created_before: z
        .string()
        .optional()
        .describe("Deprecated: use `to_date`."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Number of results to skip for pagination (default 0). " +
          "Use with limit to page through results: page 1 = offset 0, page 2 = offset 10, etc."
        ),
    }),
    handler: async (ctx: ToolContext, { query, scope, project, limit = 10, min_score = 0.35, source_tool, from_date, to_date, created_after, created_before, offset = 0 }: {
      query: string;
      scope?: "org" | "personal" | "both";
      project?: string;
      limit?: number;
      min_score?: number;
      source_tool?: string;
      from_date?: string;
      to_date?: string;
      created_after?: string;
      created_before?: string;
      offset?: number;
    }) => {
      const queryEmbedding = await embed(ctx, query);

      const { data, error } = await ctx.db.rpc("match_memories", {
        query_embedding: queryEmbedding,
        user_id_filter: ctx.userId,
        company_id_filter: ctx.companyId,
        scope_filter: scope === "both" ? null : (scope ?? null),
        project_filter: project ?? null,
        match_count: limit,
        min_score,
        source_tool_filter: source_tool ?? null,
        created_after_filter: from_date ?? created_after ?? null,
        created_before_filter: to_date ?? created_before ?? null,
        offset_param: offset,
      });

      if (error) throw new Error(`Failed to recall memories: ${error.message}`);
      return {
        memories: data ?? [],
        count: Array.isArray(data) ? data.length : 0,
        guidance:
          "If any of these memories conflicts with what you now observe, do not " +
          "blindly trust it or silently overwrite it. Investigate the cause; if " +
          "you can determine it, correct the memory (via memory_update) and tell " +
          "the user, and ask only when you cannot track down why it changed. When " +
          "updating, pass change_reason so the reason is preserved, not just the " +
          "new value.",
      };
    },
  },

  memory_forget: {
    title: "Memory Forget",
    description:
      "Delete a specific memory entry by its ID. " +
      "For org-scoped memories, a `conflict` response is returned with a preview " +
      "so the user can confirm. Pass confirm=true to skip the preview on retry.",
    parameters: z.object({
      memory_id: z.string().uuid().describe("The UUID of the memory to delete."),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Conflict resolution: 'confirm' deletes, 'cancel' aborts."),
      confirm: z
        .boolean()
        .optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Set true to delete immediately."),
    }),
    handler: async (ctx: ToolContext, { memory_id, confirm, resolution }: { memory_id: string; confirm?: boolean; resolution?: "confirm" | "cancel" }) => {
      if (resolution === "cancel") {
        return { deleted: false, message: "Cancelled. The memory was not deleted." };
      }
      const confirmed = confirm === true || resolution === "confirm";
      const userId = ctx.userId;

      // Fetch the memory first — needed for audit log and conflict preview
      const { data: mem, error: fetchErr } = await ctx.db
        .from("memories")
        .select("id, user_id, scope, project, content, created_at")
        .eq("id", memory_id)
        .or(`user_id.eq.${userId},user_id.eq.org`)
        .single();

      if (fetchErr) throw new Error(`Memory not found: ${fetchErr.message}`);

      if (confirmed) {
        const { error } = await ctx.db
          .from("memories")
          .delete()
          .eq("id", memory_id)
          .or(`user_id.eq.${userId},and(user_id.eq.org,created_by.eq.${userId})`);
        if (error) throw new Error(`Failed to delete memory: ${error.message}`);

        // Audit org-scoped deletions
        if (mem.scope === "org") {
          await writeAuditLog(ctx, {
            action: "memory_forget",
            entity_type: "memory",
            entity_id: memory_id,
            before_state: {
              scope: mem.scope,
              project: (mem as { project?: string | null }).project ?? null,
              content_excerpt: mem.content.length > 200 ? mem.content.slice(0, 200) + "..." : mem.content,
            },
          });
        }
        return { deleted: true, memory_id };
      }

      // Personal-scoped memories can be deleted immediately without confirmation
      if (mem.scope !== "org") {
        const { error } = await ctx.db
          .from("memories")
          .delete()
          .eq("id", memory_id)
          .eq("user_id", userId);
        if (error) throw new Error(`Failed to delete memory: ${error.message}`);
        return { deleted: true, memory_id };
      }

      // Org-scoped memories require confirmation — return a conflict preview
      const preview = mem.content.length > 200 ? mem.content.slice(0, 200) + "..." : mem.content;
      return conflict(
        "destructive_action",
        `This is an org-scoped memory visible to all team members. Are you sure you want to delete it?`,
        [
          { key: "confirm_delete", label: "Yes, delete this memory", value: { memory_id, resolution: "confirm" } },
          { key: "cancel", label: "Cancel", value: { resolution: "cancel" } },
        ],
        { memory_preview: preview, project: mem.project, created_at: mem.created_at }
      );
    },
  },

  memory_update: {
    title: "Memory Update",
    description:
      "Update an existing memory's content in place. Re-embeds the new content " +
      "for accurate future recall. For org-scoped memories, returns a conflict " +
      "preview showing the before/after change for user confirmation. " +
      "Pass confirm=true to apply after reviewing.",
    parameters: z.object({
      memory_id: z.string().uuid().describe("The UUID of the memory to update."),
      content: z
        .string()
        .max(20000, "Memory content exceeds 20,000 characters. Split into multiple memories or summarize before storing.")
        .describe("The new content to replace the existing memory with (max 20,000 characters)."),
      project: z
        .string()
        .optional()
        .describe("Optional: update the project tag. Omit to keep the existing tag."),
      change_reason: z
        .string()
        .optional()
        .describe(
          "Why this memory is changing - the cause you investigated (e.g. 'the project was renamed', " +
          "'the old value was superseded'). For org-scoped memories this is recorded in the audit log, " +
          "preserving why it changed, not just the new value."
        ),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Conflict resolution: 'confirm' applies the update, 'cancel' aborts."),
      confirm: z
        .boolean()
        .optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Set true to apply the update."),
    }),
    handler: async (ctx: ToolContext, { memory_id, content, project, change_reason, confirm, resolution }: {
      memory_id: string;
      content: string;
      project?: string;
      change_reason?: string;
      confirm?: boolean;
      resolution?: "confirm" | "cancel";
    }) => {
      if (resolution === "cancel") {
        return { updated: false, message: "Cancelled. The memory was not updated." };
      }
      const confirmed = confirm === true || resolution === "confirm";
      const userId = ctx.userId;

      // Fetch the existing memory with ownership guard
      const { data: mem, error: fetchErr } = await ctx.db
        .from("memories")
        .select("id, user_id, scope, project, content, created_by, created_at")
        .eq("id", memory_id)
        .or(`user_id.eq.${userId},user_id.eq.org`)
        .single();

      if (fetchErr) throw new Error(`Memory not found: ${fetchErr.message}`);

      // Org-scoped memories require confirmation unless already confirmed
      if (mem.scope === "org" && !confirmed) {
        const beforePreview = mem.content.length > 300
          ? mem.content.slice(0, 300) + "..."
          : mem.content;
        const afterPreview = content.length > 300
          ? content.slice(0, 300) + "..."
          : content;

        return conflict(
          "destructive_action",
          "This is an org-scoped memory visible to all team members. Review the change before applying.",
          [
            {
              key: "confirm_update",
              label: "Apply this update",
              value: { memory_id, content, project, change_reason, resolution: "confirm" },
            },
            { key: "cancel", label: "Cancel", value: { resolution: "cancel" } },
          ],
          {
            before: beforePreview,
            after: afterPreview,
            project_before: mem.project,
            project_after: project ?? mem.project,
          }
        );
      }

      // Org memories can only be updated by their creator
      if (mem.scope === "org" && mem.created_by !== userId) {
        throw new Error(
          `Cannot update org memory created by another user. ` +
          `Memory was created by '${mem.created_by}', you are '${userId}'.`
        );
      }

      // Re-embed the new content
      const embedding = await embed(ctx, content);

      // Build the update payload
      const updatePayload: Record<string, unknown> = {
        content,
        embedding: JSON.stringify(embedding),
      };
      if (project !== undefined) {
        updatePayload.project = project;
      }

      // Apply the update with ownership guard
      const ownershipFilter = mem.scope === "org"
        ? `user_id.eq.org,created_by.eq.${userId}`
        : `user_id.eq.${userId}`;

      const { data, error } = await ctx.db
        .from("memories")
        .update(updatePayload)
        .eq("id", memory_id)
        .or(ownershipFilter)
        .select("id, user_id, scope, project, content, created_at, updated_at")
        .single();

      if (error) throw new Error(`Failed to update memory: ${error.message}`);

      // Audit org-scoped updates
      if (mem.scope === "org") {
        await writeAuditLog(ctx, {
          action: "memory_update",
          entity_type: "memory",
          entity_id: memory_id,
          before_state: {
            content_excerpt: mem.content.length > 200 ? mem.content.slice(0, 200) + "..." : mem.content,
            project: mem.project,
          },
          after_state: {
            content_excerpt: content.length > 200 ? content.slice(0, 200) + "..." : content,
            project: project ?? mem.project,
          },
          metadata: change_reason ? { change_reason } : null,
        });
      }

      return data;
    },
  },

  memory_summarize_and_store: {
    title: "Memory Summarize & Store",
    description:
      "Distill a session summary into a memory entry and store it. " +
      "Pass a full narrative description of what happened — the more detail the better. " +
      "Call at the end of meaningful sessions.",
    parameters: z.object({
      session_summary: z
        .string()
        .max(20000, "Session summary exceeds 20,000 characters. Condense before storing.")
        .describe(
          "A narrative description of the session to memorize. Include decisions made, " +
          "context established, and anything useful for future sessions (max 20,000 characters)."
        ),
      scope: z
        .enum(["org", "personal"])
        .describe("'org' to share with the whole team, 'personal' for private notes."),
      project: z.string().optional().describe("Optional project tag."),
      kind: z
        .string()
        .optional()
        .describe(
          "Optional classifier stored in metadata.kind. Pass 'checkpoint' for end-of-session " +
          "checkpoints so get_project_history can build the project timeline."
        ),
      resolution: z
        .enum(["confirm", "cancel"])
        .optional()
        .describe("Conflict resolution after a near-duplicate is found: 'confirm' stores anyway, 'cancel' skips."),
      force: z
        .boolean()
        .optional()
        .describe("Deprecated: use `resolution: \"confirm\"`. Set true to skip near-duplicate detection."),
    }),
    handler: async (ctx: ToolContext, { session_summary, scope, project, kind, force, resolution }: {
      session_summary: string;
      scope: "org" | "personal";
      project?: string;
      kind?: string;
      force?: boolean;
      resolution?: "confirm" | "cancel";
    }) => {
      if (resolution === "cancel") {
        return { success: false, message: "Skipped. No memory was stored." };
      }
      const skipDedup = force === true || resolution === "confirm";
      const callerUserId = ctx.userId;
      const userId = scope === "org" ? "org" : callerUserId;
      const embedding = await embed(ctx, session_summary);

      // Check for near-duplicate before inserting
      if (!skipDedup) {
        const dupConflict = await checkForDuplicate(
          ctx.db, embedding, callerUserId, ctx.companyId, scope, project ?? null, session_summary
        );
        if (dupConflict) return dupConflict;
      }

      const { data, error } = await ctx.db
        .from("memories")
        .insert({
          user_id: userId,
          company_id: ctx.companyId,
          created_by: callerUserId,
          scope,
          project: project ?? null,
          content: session_summary,
          embedding: JSON.stringify(embedding),
          source_tool: "memory_summarize_and_store",
          ...(kind ? { metadata: { kind } } : {}),
        })
        .select("id, user_id, scope, project, content, created_at")
        .single();

      if (error) throw new Error(`Failed to store summary: ${error.message}`);

      // Audit org-scoped summaries — same pattern as memory_store
      if (scope === "org") {
        const memData = data as { id?: string } | null;
        await writeAuditLog(ctx, {
          action: "memory_store",
          entity_type: "memory",
          entity_id: memData?.id ?? "unknown",
          after_state: {
            scope,
            project: project ?? null,
            source_tool: "memory_summarize_and_store",
            content_excerpt: session_summary.length > 200 ? session_summary.slice(0, 200) + "..." : session_summary,
          },
        });
      }

      return data;
    },
  },
};

export function registerMemoryTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, memoryTools, ctx);
}
