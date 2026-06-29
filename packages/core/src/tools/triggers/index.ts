// ============================================================
// Founders OS — Triggers Domain (declarative watches)
// ============================================================
// Triggers make the OS proactive: declarative "this is worth reacting
// to" conditions stored as data. A deterministic evaluate_triggers runs
// the enabled ones; data conditions are evaluated and fire-claimed
// server-side, connector conditions are returned as checks for the
// agent to run and report back. Dedup (last_fired_at + last_state
// fingerprint) means a watcher fires once when a situation becomes true
// and again when it worsens, not every tick.
//
// Detection is deterministic and server-owned; judgment and action are
// the agent's job, routed through the governance gate (preview_action).
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolMap, type ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import type { Render } from "../../types/render.js";
import { writeAuditLog } from "../audit.js";
import { fingerprint, changed } from "./dedup.js";
import { dataEvaluators, DATA_CONDITION_TYPES } from "./conditions.js";
import { buildConnectorCheck, CONNECTOR_CONDITION_TYPES, type ConnectorCheck } from "./connector.js";

const ALL_CONDITION_TYPES = [...DATA_CONDITION_TYPES, ...CONNECTOR_CONDITION_TYPES];

// ── Validation helpers ─────────────────────────────────────

async function assertPlaybookBelongsToCompany(ctx: ToolContext, playbookId: string): Promise<void> {
  const { data, error } = await ctx.db
    .from("playbooks")
    .select("id")
    .eq("company_id", ctx.companyId)
    .eq("id", playbookId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Could not verify playbook: ${error.message}`);
  if (!data) throw new Error(`Playbook ${playbookId} not found for this company.`);
}

interface TriggerConfig {
  condition_source: "data" | "connector";
  condition_type: string;
  connector?: string | null;
  action_type: "run_playbook" | "create_task" | "notify";
  playbook_id?: string | null;
}

async function validateTriggerConfig(ctx: ToolContext, cfg: TriggerConfig): Promise<void> {
  if (cfg.condition_source === "data") {
    if (!DATA_CONDITION_TYPES.includes(cfg.condition_type)) {
      throw new Error(
        `condition_type "${cfg.condition_type}" is not a data condition. Data conditions: ${DATA_CONDITION_TYPES.join(", ")}.`
      );
    }
  } else {
    if (!CONNECTOR_CONDITION_TYPES.includes(cfg.condition_type)) {
      throw new Error(
        `condition_type "${cfg.condition_type}" is not a connector condition. Connector conditions: ${CONNECTOR_CONDITION_TYPES.join(", ")}.`
      );
    }
    if (!cfg.connector || cfg.connector.trim() === "") {
      throw new Error(`condition_source "connector" requires a connector (e.g. "stripe").`);
    }
  }
  if (cfg.action_type === "run_playbook") {
    if (!cfg.playbook_id) throw new Error(`action_type "run_playbook" requires a playbook_id.`);
    await assertPlaybookBelongsToCompany(ctx, cfg.playbook_id);
  }
}

// ── Fire-claim (atomic conditional UPDATE) ─────────────────
// Claims the fire for one trigger by moving last_state to the new
// fingerprint ONLY when it differs (IS DISTINCT FROM, including the
// first-ever evaluation where last_state is null). Two overlapping
// ticks therefore serialize: the first claims and the second sees the
// fingerprint already stored and does nothing. last_fired_at is bumped
// only when the condition actually matched, so a transition to
// "no longer matching" updates state (so re-matching re-fires) without
// recording a fire. A pg advisory lock keyed on company_id is the
// documented hardening follow-up; the conditional update already gives
// single-fire-per-state without it.

async function claimFire(
  ctx: ToolContext,
  triggerId: string,
  fp: string,
  matched: boolean
): Promise<boolean> {
  const patch: Record<string, unknown> = { last_state: fp };
  if (matched) patch.last_fired_at = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("triggers")
    .update(patch)
    .eq("company_id", ctx.companyId)
    .eq("id", triggerId)
    // IS DISTINCT FROM: matches when last_state is null OR differs.
    .or(`last_state.is.null,last_state.neq.${fp}`)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Fire-claim failed for trigger ${triggerId}: ${error.message}`);
  return Boolean(data);
}

// ── Resolved-action reference for a fired trigger ──────────

interface TriggerRow {
  id: string;
  name: string;
  condition_source: "data" | "connector";
  condition_type: string;
  connector: string | null;
  params: Record<string, unknown> | null;
  action_type: string;
  playbook_id: string | null;
  action_params: Record<string, unknown> | null;
  last_state: string | null;
  created_by: string;
  enabled: boolean;
}

function resolvedActionRef(t: TriggerRow, brief: string) {
  return {
    trigger_id: t.id,
    name: t.name,
    condition_type: t.condition_type,
    brief,
    action: {
      action_type: t.action_type,
      playbook_id: t.playbook_id,
      // Templated params; resolved + classified inside preview_action.
      action_params: t.action_params ?? {},
    },
    next_step:
      "Route this action through preview_action before performing it; if held, wait for a human approval.",
  };
}

const TRIGGER_SELECT =
  "id, name, condition_source, condition_type, connector, params, action_type, playbook_id, action_params, last_state, created_by, enabled";

// ── Render helpers ─────────────────────────────────────────

function listTriggersRender(rows: Array<Record<string, unknown>>): Render {
  const line = (r: Record<string, unknown>) => {
    const installed = String(r.created_by ?? "").startsWith("playbook:") ? " (installed by automation)" : "";
    return `| ${r.enabled ? "enabled" : "disabled"} | ${r.name} | ${r.condition_source}/${r.condition_type}${installed} | ${r.cadence_hint ?? ""} |`;
  };
  const md = rows.length
    ? "| State | Name | Condition | Cadence |\n|---|---|---|---|\n" + rows.map(line).join("\n")
    : "No triggers configured yet.";
  return {
    tier_1: {
      format_hint: "status_groups",
      instructions: {
        scope: "Render the triggers grouped into enabled and disabled. This is the 'what is Founders OS watching' surface.",
        format:
          "Two groups (enabled, disabled). Each row shows the name, a data/connector badge, the condition_type, an 'installed by automation' badge when created_by starts with 'playbook:', and the cadence.",
        forbidden: "Do not omit disabled triggers; the user needs to see what is paused.",
      },
    },
    tier_3: { markdown: md },
  };
}

// ── Tools ──────────────────────────────────────────────────

export const triggerTools: ToolMap = {
  create_trigger: {
    title: "Create Trigger",
    description:
      "Register a watch. condition_source is 'data' (server-evaluated SQL: " +
      DATA_CONDITION_TYPES.join(", ") +
      ") or 'connector' (agent-evaluated via a connected tool: " +
      CONNECTOR_CONDITION_TYPES.join(", ") +
      "; connector required). action_type is run_playbook (playbook_id required and verified), create_task, or notify. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      name: z.string().describe("Short human name for the watch."),
      condition_type: z.enum([
        "stalled_deal", "overspend", "budget_threshold",
        "overdue_task", "stuck_task", "feed_keyword_match", "overdue_invoice",
      ]).describe("What to watch for."),
      condition_source: z.enum(["data", "connector"]).optional().describe("'data' (default) or 'connector'."),
      connector: z.string().optional().describe("Required when condition_source is 'connector' (e.g. 'stripe')."),
      params: z.record(z.unknown()).optional().describe("Condition params, e.g. { days: 14 } or { threshold_cents: 500000, window_days: 30 }."),
      action_type: z.enum(["run_playbook", "create_task", "notify"]).optional().describe("What to do when it fires. Default run_playbook."),
      playbook_id: z.string().uuid().optional().describe("Required when action_type is run_playbook. Must belong to this company."),
      action_params: z.record(z.unknown()).optional().describe("Templated action params; resolved + classified inside preview_action when the action runs."),
      cadence_hint: z.enum(["hourly", "daily", "weekly"]).optional().describe("Advisory check cadence. Default daily."),
      scope: z.enum(["org", "personal"]).optional().describe("Visibility. Default org."),
      owner_id: z.string().optional().describe("Owner for personal-scope triggers."),
      digest: z.boolean().optional().describe("Roll up into a digest rather than firing individually. Default false."),
      bound_entity_type: z.string().optional().describe("Entity this watch is bound to (e.g. 'customer'), for cascade cleanup."),
      bound_entity_id: z.string().uuid().optional().describe("Id of the bound entity."),
      source_run_id: z.string().uuid().optional().describe("When a playbook run installs this watch, pass the run id; created_by is recorded as 'playbook:<run-id>' so cleanup and the 'installed by automation' badge work."),
    }),
    handler: async (ctx: ToolContext, p: {
      name: string; condition_type: string; condition_source?: "data" | "connector";
      connector?: string; params?: Record<string, unknown>; action_type?: "run_playbook" | "create_task" | "notify";
      playbook_id?: string; action_params?: Record<string, unknown>; cadence_hint?: "hourly" | "daily" | "weekly";
      scope?: "org" | "personal"; owner_id?: string; digest?: boolean; bound_entity_type?: string; bound_entity_id?: string;
      source_run_id?: string;
    }) => {
      const condition_source = p.condition_source ?? "data";
      const action_type = p.action_type ?? "run_playbook";
      await validateTriggerConfig(ctx, {
        condition_source, condition_type: p.condition_type, connector: p.connector,
        action_type, playbook_id: p.playbook_id,
      });
      // Playbook-authored watches carry a 'playbook:<run-id>' provenance so
      // cascade cleanup and the "installed by automation" badge can find them.
      const created_by = p.source_run_id ? `playbook:${p.source_run_id}` : ctx.userId;

      const { data, error } = await ctx.db.from("triggers").insert({
        company_id: ctx.companyId,
        name: p.name,
        condition_source,
        condition_type: p.condition_type,
        connector: p.connector ?? null,
        params: p.params ?? {},
        action_type,
        playbook_id: p.playbook_id ?? null,
        action_params: p.action_params ?? {},
        cadence_hint: p.cadence_hint ?? "daily",
        scope: p.scope ?? "org",
        owner_id: p.owner_id ?? null,
        digest: p.digest ?? false,
        bound_entity_type: p.bound_entity_type ?? null,
        bound_entity_id: p.bound_entity_id ?? null,
        created_by,
        enabled: true,
      }).select(TRIGGER_SELECT + ", cadence_hint").maybeSingle();
      if (error) throw new Error(`Failed to create trigger: ${error.message}`);

      return { success: true, trigger: data, render: listTriggersRender(data ? [data as unknown as Record<string, unknown>] : []) };
    },
  },

  list_triggers: {
    title: "List Triggers",
    description:
      "The 'what is Founders OS watching' surface. Lists triggers grouped by enabled/disabled with data/connector and 'installed by automation' badges. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      include_disabled: z.boolean().optional().describe("Include disabled triggers. Default true."),
    }),
    handler: async (ctx: ToolContext, { include_disabled = true }: { include_disabled?: boolean }) => {
      let q = ctx.db
        .from("triggers")
        .select(TRIGGER_SELECT + ", cadence_hint, digest, created_at")
        .eq("company_id", ctx.companyId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (!include_disabled) q = q.eq("enabled", true);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to list triggers: ${error.message}`);
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return { triggers: rows, count: rows.length, render: listTriggersRender(rows) };
    },
  },

  update_trigger: {
    title: "Update Trigger",
    description:
      "Enable/disable a trigger, retune its params or cadence, or change its action. Re-validates on change. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      trigger_id: z.string().uuid().describe("The trigger to update."),
      enabled: z.boolean().optional(),
      params: z.record(z.unknown()).optional(),
      cadence_hint: z.enum(["hourly", "daily", "weekly"]).optional(),
      action_type: z.enum(["run_playbook", "create_task", "notify"]).optional(),
      playbook_id: z.string().uuid().optional(),
      action_params: z.record(z.unknown()).optional(),
    }),
    handler: async (ctx: ToolContext, p: {
      trigger_id: string; enabled?: boolean; params?: Record<string, unknown>;
      cadence_hint?: "hourly" | "daily" | "weekly"; action_type?: "run_playbook" | "create_task" | "notify";
      playbook_id?: string; action_params?: Record<string, unknown>;
    }) => {
      const { data: existing, error: exErr } = await ctx.db
        .from("triggers")
        .select(TRIGGER_SELECT)
        .eq("company_id", ctx.companyId)
        .eq("id", p.trigger_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (exErr) throw new Error(`Failed to load trigger: ${exErr.message}`);
      if (!existing) throw new Error(`Trigger ${p.trigger_id} not found.`);
      const cur = existing as TriggerRow;

      const nextActionType = p.action_type ?? (cur.action_type as TriggerConfig["action_type"]);
      const nextPlaybookId = p.playbook_id ?? cur.playbook_id;
      if (p.action_type !== undefined || p.playbook_id !== undefined) {
        await validateTriggerConfig(ctx, {
          condition_source: cur.condition_source,
          condition_type: cur.condition_type,
          connector: cur.connector,
          action_type: nextActionType,
          playbook_id: nextPlaybookId,
        });
      }

      const patch: Record<string, unknown> = {};
      if (p.enabled !== undefined) patch.enabled = p.enabled;
      if (p.params !== undefined) patch.params = p.params;
      if (p.cadence_hint !== undefined) patch.cadence_hint = p.cadence_hint;
      if (p.action_type !== undefined) patch.action_type = p.action_type;
      if (p.playbook_id !== undefined) patch.playbook_id = p.playbook_id;
      if (p.action_params !== undefined) patch.action_params = p.action_params;
      if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");

      const { data, error } = await ctx.db
        .from("triggers")
        .update(patch)
        .eq("company_id", ctx.companyId)
        .eq("id", p.trigger_id)
        .select(TRIGGER_SELECT + ", cadence_hint")
        .maybeSingle();
      if (error) throw new Error(`Failed to update trigger: ${error.message}`);
      return { success: true, trigger: data };
    },
  },

  delete_trigger: {
    title: "Delete Trigger",
    description: "Soft-delete a trigger (sets deleted_at). It stops being evaluated. Reversible via restore until purged.",
    parameters: z.object({
      trigger_id: z.string().uuid().describe("The trigger to delete."),
    }),
    handler: async (ctx: ToolContext, { trigger_id }: { trigger_id: string }) => {
      const { data, error } = await ctx.db
        .from("triggers")
        .update({ deleted_at: new Date().toISOString(), enabled: false })
        .eq("company_id", ctx.companyId)
        .eq("id", trigger_id)
        .is("deleted_at", null)
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`Failed to delete trigger: ${error.message}`);
      if (!data) throw new Error(`Trigger ${trigger_id} not found or already deleted.`);
      return { success: true, deleted: trigger_id };
    },
  },

  evaluate_triggers: {
    title: "Evaluate Triggers",
    description:
      "Run all enabled triggers for the company. Data conditions are evaluated, deduped, and fire-claimed server-side; the response's `fired` array lists those that newly fired with a resolved-action reference and brief. Connector conditions are NOT fired here; they are returned in `connector_checks` for you to run the named connector tool and then call report_trigger_observation. Set dry_evaluate true to see what would fire without recording it. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      condition_types: z.array(z.string()).optional().describe("Restrict to these condition_types. Omit for all."),
      dry_evaluate: z.boolean().optional().describe("Evaluate without fire-claiming (no state writes). Default false."),
    }),
    handler: async (ctx: ToolContext, { condition_types, dry_evaluate = false }: { condition_types?: string[]; dry_evaluate?: boolean }) => {
      let q = ctx.db
        .from("triggers")
        .select(TRIGGER_SELECT)
        .eq("company_id", ctx.companyId)
        .eq("enabled", true)
        .is("deleted_at", null);
      if (condition_types && condition_types.length > 0) q = q.in("condition_type", condition_types);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to load triggers: ${error.message}`);
      const triggers = (data ?? []) as TriggerRow[];

      const fired: ReturnType<typeof resolvedActionRef>[] = [];
      const connector_checks: ConnectorCheck[] = [];
      const errors: Array<{ trigger_id: string; name: string; error: string }> = [];
      let evaluated = 0;

      // Per-trigger isolation: one bad trigger (a DB hiccup, a misconfigured
      // connector condition, an unknown data condition) must not abort the
      // whole tick and starve every other watcher. Failures are collected
      // and surfaced, not thrown.
      for (const t of triggers) {
        try {
          if (t.condition_source === "connector") {
            connector_checks.push(buildConnectorCheck(t));
            continue;
          }
          const evaluator = dataEvaluators[t.condition_type];
          if (!evaluator) {
            errors.push({
              trigger_id: t.id,
              name: t.name,
              error: `No data evaluator for condition_type "${t.condition_type}"; the trigger is misconfigured and never fires.`,
            });
            continue;
          }
          evaluated++;
          const result = await evaluator(ctx, t.params ?? {});
          const fp = fingerprint(result.rows.map((r) => r.id), result.state_field);

          if (dry_evaluate) {
            if (result.matched && changed(t.last_state, fp)) fired.push(resolvedActionRef(t, result.brief));
            continue;
          }

          const claimed = await claimFire(ctx, t.id, fp, result.matched);
          if (result.matched && claimed) {
            await writeAuditLog(ctx, {
              action: "trigger_fired",
              entity_type: "trigger",
              entity_id: t.id,
              metadata: { condition_type: t.condition_type, brief: result.brief, source: "data" },
            });
            fired.push(resolvedActionRef(t, result.brief));
          }
        } catch (e) {
          errors.push({ trigger_id: t.id, name: t.name, error: e instanceof Error ? e.message : "unknown error" });
        }
      }

      return {
        evaluated,
        fired,
        fired_count: fired.length,
        connector_checks,
        connector_check_count: connector_checks.length,
        errors,
        error_count: errors.length,
        dry_evaluate,
        render: {
          tier_1: {
            format_hint: "status_groups",
            instructions: {
              scope: "Show the fired triggers (each with its brief and action) and the connector_checks still to run.",
              format: "Two groups: 'Fired now' (with brief + the action to route through preview_action) and 'Checks to run' (connector + what to fetch). Keep it compact.",
              forbidden: "Do not perform any fired action directly; route each through preview_action first.",
            },
          },
          tier_3: {
            markdown:
              `Fired: ${fired.length}. Connector checks to run: ${connector_checks.length}.` +
              (fired.length ? "\n\n" + fired.map((f) => `- ${f.name}: ${f.brief}`).join("\n") : ""),
          },
        } satisfies Render,
      };
    },
  },

  report_trigger_observation: {
    title: "Report Trigger Observation",
    description:
      "Report the result of running a connector check from evaluate_triggers. The server computes the dedup fingerprint and fire-claims, so firing stays authoritative on the server even though you fetched the data. Pass trigger_id, rows (one { id } per matching external row), and state (the per-condition material state, e.g. a days-overdue bucket or the latest matched item id). Returns whether the trigger fired plus the resolved-action reference. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      trigger_id: z.string().uuid().describe("The trigger from the connector check."),
      rows: z.array(z.object({ id: z.string() })).describe("Matching external rows, normalized to ids. Empty array = no match (records the all-clear)."),
      state: z.string().optional().describe("Per-condition material state value (e.g. days-overdue bucket, latest matched item id). Folded into dedup so a worsening situation re-fires."),
      brief: z.string().optional().describe("Optional short human description of what was observed."),
    }),
    handler: async (ctx: ToolContext, p: { trigger_id: string; rows: { id: string }[]; state?: string; brief?: string }) => {
      const { data: t, error } = await ctx.db
        .from("triggers")
        .select(TRIGGER_SELECT)
        .eq("company_id", ctx.companyId)
        .eq("id", p.trigger_id)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(`Failed to load trigger: ${error.message}`);
      if (!t) throw new Error(`Trigger ${p.trigger_id} not found.`);
      const trig = t as TriggerRow;
      if (trig.condition_source !== "connector") {
        throw new Error(`Trigger ${p.trigger_id} is a data condition; it is evaluated server-side, not reported.`);
      }

      const matched = p.rows.length > 0;
      const fp = fingerprint(p.rows.map((r) => r.id), p.state ?? "");
      const claimed = await claimFire(ctx, trig.id, fp, matched);

      const brief = p.brief ?? `${p.rows.length} match${p.rows.length === 1 ? "" : "es"} for ${trig.condition_type}`;
      if (matched && claimed) {
        await writeAuditLog(ctx, {
          action: "trigger_fired",
          entity_type: "trigger",
          entity_id: trig.id,
          metadata: { condition_type: trig.condition_type, brief, source: "connector" },
        });
        return { fired: true, ...resolvedActionRef(trig, brief) };
      }
      return {
        fired: false,
        trigger_id: trig.id,
        reason: !matched ? "No matching rows; recorded the all-clear." : "No change since the last fire (deduped).",
      };
    },
  },
};

export function registerTriggerTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, triggerTools, ctx);
}
