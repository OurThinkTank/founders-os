// ============================================================
// Founders OS — Notifications inbox
// ============================================================
// A lightweight, free-form heads-up surface. `notify_inbox` is the
// home for the design's native:notify_inbox action: a pure "you should
// know this" note that should NOT clutter the task list. The headless
// agent posts these for the next interactive session to read; any
// other source (a trigger, a manual call) can post too.
//
// notify_inbox is a native write (insert one row), so it classifies
// native_create / allow_with_log for the autonomous principal: no
// confirm_token, autonomous-safe. It is the only notifications tool in
// the headless agent's allowlist; list/mark are interactive surfaces.
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import type { Render } from "../../types/render.js";

/**
 * Principal label for created_by, mirroring runHoldOnly's acted_by
 * convention: an autonomous run records `autonomous-run:<runId>`; an
 * interactive session records the user id.
 */
function principalLabel(ctx: ToolContext): string {
  const a = ctx.actor;
  return a && a.kind === "autonomous" ? `autonomous-run:${a.runId}` : ctx.userId;
}

export const notificationTools: ToolMap = {
  // ──────────────────────────────────────────────────────────
  // notify_inbox  (write, agent-facing)
  // ──────────────────────────────────────────────────────────
  notify_inbox: {
    title: "Notify Inbox",
    description:
      "Post a free-form heads-up to the founder's notifications inbox: a pure 'you should know this' note that does not belong on the task list. Use this instead of create_task when there is nothing to do, only something to be aware of. level is 'info' (default) or 'warning'. The note appears in the next session briefing until marked read.",
    parameters: z.object({
      title: z.string().min(1).describe("Short headline of the notification."),
      body: z.string().optional().describe("Optional longer detail."),
      level: z
        .enum(["info", "warning"])
        .optional()
        .describe("Severity: 'info' (default) or 'warning'."),
      source: z
        .string()
        .optional()
        .describe(
          "Optional provenance, e.g. 'trigger:<id>'. Defaults to the calling principal."
        ),
    }),
    handler: async (
      ctx: ToolContext,
      {
        title,
        body,
        level = "info",
        source,
      }: { title: string; body?: string; level?: "info" | "warning"; source?: string }
    ) => {
      const principal = principalLabel(ctx);
      const { data, error } = await ctx.db
        .from("notifications")
        .insert({
          company_id: ctx.companyId,
          title,
          body: body ?? null,
          level,
          source: source ?? principal,
          created_by: principal,
        })
        .select("id, title, body, level, source, created_by, read_at, created_at")
        .single();
      if (error) throw new Error(`Failed to post notification: ${error.message}`);

      return { success: true, notification: data };
    },
  },

  // ──────────────────────────────────────────────────────────
  // list_notifications  (read, interactive/surface-facing)
  // ──────────────────────────────────────────────────────────
  list_notifications: {
    title: "List Notifications",
    description:
      "Read the founder's notifications inbox: free-form heads-up notes posted by the headless agent or other sources. Defaults to unread; pass status 'all' to include already-read notes. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      status: z
        .enum(["unread", "all"])
        .optional()
        .describe("Filter by read state. Default 'unread'."),
    }),
    handler: async (
      ctx: ToolContext,
      { status = "unread" }: { status?: "unread" | "all" }
    ) => {
      let q = ctx.db
        .from("notifications")
        .select("id, title, body, level, source, created_by, read_at, created_at")
        .eq("company_id", ctx.companyId)
        .order("created_at", { ascending: false });
      if (status === "unread") q = q.is("read_at", null);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to list notifications: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;

      const md = rows.length
        ? "| Level | Notification |\n|---|---|\n" +
          rows
            .map((r) => `| ${r.level} | ${r.title}${r.body ? ` — ${r.body}` : ""} |`)
            .join("\n")
        : "No unread notifications.";

      return {
        notifications: rows,
        count: rows.length,
        render: {
          tier_1: {
            format_hint: "status_groups",
            instructions: {
              scope:
                "Show unread notifications, each with its title as the headline and body as detail.",
              format:
                "A compact list; emphasize warning-level notes per the standard color conventions (amber for warning, neutral for info).",
              forbidden:
                "Do not invent actions from a notification; it is a heads-up, not a task.",
            },
          },
          tier_3: { markdown: md },
          do_not: [
            "Do not invent new color meanings; use the standard color conventions.",
            "For 2 or fewer notifications, inline rendering is fine.",
          ],
        } satisfies Render,
      };
    },
  },

  // ──────────────────────────────────────────────────────────
  // mark_notifications_read  (write, interactive-facing)
  // ──────────────────────────────────────────────────────────
  mark_notifications_read: {
    title: "Mark Notifications Read",
    description:
      "Clear notifications from the unread inbox once the founder has seen them. Pass specific notification ids, or omit ids to mark every unread notification read. Not available to the headless agent.",
    parameters: z.object({
      ids: z
        .array(z.string().uuid())
        .optional()
        .describe(
          "UUIDs of notifications to mark read (from list_notifications). Omit to mark all unread read."
        ),
    }),
    handler: async (ctx: ToolContext, { ids }: { ids?: string[] }) => {
      let q = ctx.db
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("company_id", ctx.companyId)
        .is("read_at", null);
      if (ids && ids.length > 0) q = q.in("id", ids);
      const { data, error } = await q.select("id");
      if (error) throw new Error(`Failed to mark notifications read: ${error.message}`);
      const cleared = (data ?? []) as Array<{ id: string }>;

      return { success: true, marked_read: cleared.length, ids: cleared.map((r) => r.id) };
    },
  },
};

export function registerNotificationTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, notificationTools, ctx);
}
