// ============================================================
// Founders OS — Governance Domain (Withhold + Record + Reconcile)
// ============================================================
// The governance gate the agent passes before a consequential action.
// It does NOT prevent an external action — Founders OS is the
// orchestration layer and the connectors live on the agent's side of
// the boundary, so the server cannot intercept a connector call. What
// this domain guarantees instead (read governance docs before any
// marketing copy):
//
//   WITHHOLD  the runnable payload of a held action is produced and
//             classified only inside preview_action; the cheapest path
//             to something sendable runs through the gate.
//   RECORD    every preview / hold / approve / reject / execute writes
//             an immutable audit_log entry (the flight recorder).
//   RECONCILE (later step) diffs connector activity against the record
//             and flags anything off-book.
//
// The one real lever is APPROVER != AGENT: approve_action is exported
// for human channels (Slack callback, web, a human's own session) and
// is deliberately NOT in the ToolMap handed to the agent. execute_action
// only READS the approved row; it can never set it.
//
// Pattern A-contextual. Every read/write is scoped by ctx.companyId.
// ============================================================

import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerToolMap, type ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";
import type { Render } from "../../types/render.js";
import { writeAuditLog } from "../audit.js";
import {
  classifyAction,
  canonicalActionString,
  RED_TIERS,
  type ProposedAction,
  type RiskTier,
} from "../playbooks/risk.js";
import {
  loadPolicy,
  savePolicy,
  validateTierOutcomes,
  resolveOutcome,
  type ResolvedOutcome,
} from "./policy.js";
import { issueToken, verifyToken } from "./token.js";
import { deliverApproval } from "./delivery.js";
import { reconcileActivities } from "./reconcile.js";

// ── Shared param shapes ────────────────────────────────────

const proposedActionSchema = z.object({
  kind: z
    .enum(["native", "external"])
    .describe("'native' stays inside Founders OS; 'external' is dispatched to a connector (Slack, Stripe, ...)."),
  connector: z
    .string()
    .nullish()
    .describe("Connector id for external actions, e.g. 'slack' or 'stripe'. Null for native."),
  action: z
    .string()
    .nullish()
    .describe("Connector verb, e.g. 'send_message', 'create_charge', 'delete_customer'."),
  params: z
    .record(z.unknown())
    .nullish()
    .describe("Action parameters. May contain {{placeholder}} tokens resolved via template_context."),
  summary: z
    .string()
    .nullish()
    .describe("Optional one-line human description of the action."),
});

type ProposedActionInput = z.infer<typeof proposedActionSchema>;

function toProposedAction(a: ProposedActionInput): ProposedAction {
  return {
    kind: a.kind,
    connector: a.connector ?? null,
    action: a.action ?? null,
    params: (a.params as Record<string, unknown> | null) ?? null,
    summary: a.summary ?? null,
  };
}

function actionHash(a: ProposedAction): string {
  return "sha256:" + createHash("sha256").update(canonicalActionString(a)).digest("hex");
}

// ── Server-side template resolution (the "withhold" point) ──
// Replaces {{path}} tokens in resolved params from a caller-supplied
// context map. This is where a trigger's or playbook's templated
// params become a runnable payload — produced inside preview_action,
// not handed to the agent ready-to-send. Dotted paths walk nested
// context objects. Unresolved tokens are left intact on purpose so the
// classifier sees them and flags a residual sensitive placeholder.

function getPath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, ctx);
}

export function resolveTemplates(
  value: unknown,
  context: Record<string, unknown>,
  depth = 0
): unknown {
  if (depth > 50) return value;
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, path: string) => {
      const resolved = getPath(context, path.trim());
      return resolved === undefined || resolved === null ? whole : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, context, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveTemplates(v, context, depth + 1);
    }
    return out;
  }
  return value;
}

// ── Render helpers ─────────────────────────────────────────

function pendingListRender(rows: PendingRow[]): Render {
  const md =
    rows.length === 0
      ? "No actions are waiting for approval."
      : "| Tier | Action | Summary | Resolved params | Requested |\n|---|---|---|---|---|\n" +
        rows
          .map((r) => {
            const params = r.action_params ? JSON.stringify(r.action_params) : "";
            const paramsCell = params.length > 120 ? params.slice(0, 117) + "..." : params;
            return `| ${RED_TIERS.has(r.tier) ? `**${r.tier.toUpperCase()}**` : r.tier} | ${r.action_type} | ${r.summary} | ${paramsCell.replace(/\|/g, "\\|")} | ${r.created_at} |`;
          })
          .join("\n");
  return {
    tier_1: {
      format_hint: "status_groups",
      instructions: {
        scope:
          "Render the pending approvals as a list grouped by tier; destructive and exfiltration come first.",
        format:
          "List with a tier chip per row. Render destructive and exfiltration tiers in BOLD RED per the standard color conventions; show the summary, the action_type, and the resolved action_params for each so the approver sees exactly what would be sent.",
        forbidden:
          "Do not hide or summarize away a destructive or exfiltration row. Do not present an approve control to the agent; approval is a human action.",
      },
    },
    tier_3: { markdown: md },
    do_not: [
      "Do not invent new color meanings; use the standard color conventions (red = destructive/danger).",
      "Do not approve on the user's behalf; only a human approves.",
    ],
  };
}

function previewRender(
  outcome: ResolvedOutcome,
  tier: RiskTier,
  summary: string,
  reasons: string[]
): Render {
  const red = RED_TIERS.has(tier);
  const md = [
    `**Proposed action:** ${summary}`,
    `**Risk tier:** ${red ? `**${tier.toUpperCase()}**` : tier}`,
    `**Outcome:** ${outcome}`,
    "",
    "**Why:**",
    ...reasons.map((r) => `- ${r}`),
  ].join("\n");
  return {
    tier_1: {
      format_hint: "incident",
      instructions: {
        scope:
          "Show the proposed action, its risk tier, the gate outcome, and the per-reason breakdown.",
        format:
          "Decision card. If outcome is hold_for_approval or paused, make that prominent. Render destructive and exfiltration tiers in BOLD RED per the standard color conventions. Quote the reasons verbatim.",
        forbidden:
          "Do not present the action as already done. If outcome is hold_for_approval, do not perform the action; wait for a human approval. If paused, do not perform the action at all.",
      },
    },
    tier_3: { markdown: md },
    do_not: [
      "Do not invent new color meanings; use the standard color conventions.",
      "Do not call execute_action for a held action until a human has approved it.",
    ],
  };
}

interface PendingRow {
  id: string;
  jti: string;
  action_type: string;
  action_params?: Record<string, unknown> | null;
  action_hash?: string;
  tier: RiskTier;
  source?: string;
  summary: string;
  status: string;
  created_at: string;
}

// ── The exported handlers shared by tools + human channels ──

/**
 * Move a held action to approved or rejected. EXPORTED for human
 * channels only (Slack interactive callback, web surface, a human's own
 * authenticated session). It is intentionally NOT in governanceTools,
 * so the autonomous agent cannot self-approve. `approver_id` is the
 * human's identity and is recorded; it must not be the agent.
 */
export async function approveAction(
  ctx: ToolContext,
  params: {
    approval_id?: string;
    jti?: string;
    decision: "approve" | "reject";
    approver_id: string;
  }
): Promise<unknown> {
  const { approval_id, jti, decision, approver_id } = params;
  if (!approval_id && !jti) {
    throw new Error("approve_action requires approval_id or jti.");
  }
  if (!approver_id || approver_id.trim().length === 0) {
    throw new Error("approve_action requires a human approver_id (the approver must not be the agent).");
  }

  let q = ctx.db
    .from("pending_approvals")
    .select("id, jti, action_type, action_hash, tier, summary, status")
    .eq("company_id", ctx.companyId);
  q = approval_id ? q.eq("id", approval_id) : q.eq("jti", jti!);
  const { data: row, error } = await q.maybeSingle();
  if (error) throw new Error(`Failed to load approval: ${error.message}`);
  if (!row) throw new Error("No matching pending approval found.");
  if (row.status !== "pending") {
    throw new Error(`Approval is already '${row.status}'; only a pending approval can be decided.`);
  }

  const nextStatus = decision === "approve" ? "approved" : "rejected";
  const nowIso = new Date().toISOString();

  // Atomic decide: only flips a row that is still 'pending'. If a
  // concurrent decision already moved it, zero rows return and we refuse.
  const { data: updated, error: upErr } = await ctx.db
    .from("pending_approvals")
    .update({
      status: nextStatus,
      approved_by: approver_id,
      approved_at: nowIso,
      updated_at: nowIso,
    })
    .eq("company_id", ctx.companyId)
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (upErr) throw new Error(`Failed to record decision: ${upErr.message}`);
  if (!updated) throw new Error("Approval was already decided by someone else.");

  await writeAuditLog(ctx, {
    action: decision === "approve" ? "action_approved" : "action_rejected",
    entity_type: "action",
    entity_id: row.id,
    metadata: {
      jti: row.jti,
      tier: row.tier,
      action_type: row.action_type,
      approver: approver_id,
    },
  });

  // On approval, mint a FRESH token bound to the same jti + action_hash
  // so the next clock tick (or callback) executes inside a valid window
  // even though the original preview token has long expired.
  let confirm_token: string | undefined;
  if (decision === "approve") {
    confirm_token = issueToken(row.jti, row.action_hash, row.tier as RiskTier).token;
  }

  return {
    success: true,
    approval_id: row.id,
    status: nextStatus,
    approver: approver_id,
    confirm_token,
    note:
      decision === "approve"
        ? "Approved. The fresh confirm_token authorizes execute_action for this exact action until it expires."
        : "Rejected. execute_action will refuse this action.",
  };
}

/**
 * Decide a batch of held actions at once. EXPORTED for human channels
 * only (the same approver != agent rule as approveAction; it is not in
 * the agent tool map). Pairs with dry-run mode, where the policy holds
 * everything: a founder turns dry-run on, watches the backlog fill, then
 * clears it in one human action. With no approval_ids, it decides every
 * pending approval. Per-row failures (already decided by someone else)
 * are reported as skipped, not fatal.
 */
export async function bulkApproveActions(
  ctx: ToolContext,
  params: { approver_id: string; decision?: "approve" | "reject"; approval_ids?: string[] }
): Promise<unknown> {
  const { approver_id, decision = "approve", approval_ids } = params;
  if (!approver_id || approver_id.trim().length === 0) {
    throw new Error("bulk approve requires a human approver_id (the approver must not be the agent).");
  }

  let ids = approval_ids;
  if (!ids || ids.length === 0) {
    const { data, error } = await ctx.db
      .from("pending_approvals")
      .select("id")
      .eq("company_id", ctx.companyId)
      .eq("status", "pending");
    if (error) throw new Error(`Failed to load pending approvals: ${error.message}`);
    ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  const results: Array<{ approval_id: string; status: string; confirm_token?: string; skipped?: boolean; error?: string }> = [];
  for (const id of ids) {
    try {
      const r = (await approveAction(ctx, { approval_id: id, decision, approver_id })) as {
        status: string; confirm_token?: string;
      };
      results.push({ approval_id: id, status: r.status, confirm_token: r.confirm_token });
    } catch (e) {
      results.push({ approval_id: id, status: "skipped", skipped: true, error: e instanceof Error ? e.message : "unknown" });
    }
  }

  const decided = results.filter((r) => !r.skipped).length;
  return {
    success: true,
    decision,
    decided,
    skipped: results.length - decided,
    approver: approver_id,
    results,
  };
}

// ── Tool map (agent-callable) ──────────────────────────────

export const governanceTools: ToolMap = {
  preview_action: {
    title: "Preview Action",
    description:
      "Classify a proposed action and return its risk tier, the gate outcome (allow / allow_with_log / hold_for_approval / paused), a per-reason breakdown, and a signed confirm_token. Call this BEFORE performing any consequential action (any external connector write, any delete, anything carrying private data). Resolves {{placeholder}} params server-side via template_context. When the outcome is hold_for_approval it records a pending approval and you must wait for a human to approve before calling execute_action. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      action: proposedActionSchema,
      template_context: z
        .record(z.unknown())
        .optional()
        .describe("Values used to resolve {{placeholder}} tokens in action.params, e.g. { customer: { email: 'a@b.com' } }."),
      source: z
        .string()
        .optional()
        .describe("Origin of the action: 'agent' (default), 'trigger:<id>', or 'playbook:<run-id>'."),
    }),
    handler: async (
      ctx: ToolContext,
      { action, template_context, source = "agent" }: {
        action: ProposedActionInput;
        template_context?: Record<string, unknown>;
        source?: string;
      }
    ) => {
      // Resolve templated params SERVER-SIDE — this is the withhold point.
      const base = toProposedAction(action);
      const resolvedParams = template_context
        ? (resolveTemplates(base.params ?? {}, template_context) as Record<string, unknown>)
        : base.params;
      const resolved: ProposedAction = { ...base, params: resolvedParams ?? null };

      const assessment = classifyAction(resolved);
      const summary =
        resolved.summary ??
        `${resolved.kind === "external" ? resolved.connector ?? "connector" : "Founders OS"} ${resolved.action ?? "action"}`;

      // Structured per-signal risk breakdown so a UI can show exactly which
      // resolved values drove the tier, not just the plain-language reasons.
      const risk_breakdown = {
        tier: assessment.tier,
        destructive: assessment.destructive,
        exfiltration: assessment.exfiltration,
        signals: {
          sensitive_placeholders: assessment.sensitive_placeholders,
          contact_emails: assessment.emails,
          financial_values: assessment.financial_values,
          secrets: assessment.secrets_found,
        },
        reasons: assessment.reasons,
      };

      // SSRF / non-http URLs are refused regardless of tier.
      if (assessment.blocks.length > 0) {
        return {
          outcome: "blocked" as const,
          tier: assessment.tier,
          blocked: assessment.blocks,
          summary,
          reasons: assessment.reasons,
          risk_breakdown,
          render: previewRender("hold_for_approval", assessment.tier, summary, assessment.reasons),
        };
      }

      const policy = await loadPolicy(ctx);
      const outcome = resolveOutcome(policy, assessment.tier);
      const hash = actionHash(resolved);

      await writeAuditLog(ctx, {
        action: "action_previewed",
        entity_type: "action",
        entity_id: hash,
        metadata: { tier: assessment.tier, outcome, source, summary },
      });

      // Paused: write nothing further, issue no token, perform nothing.
      if (outcome === "paused") {
        return {
          outcome,
          tier: assessment.tier,
          summary,
          reasons: ["Agents are paused company-wide. No action will be taken."],
          risk_breakdown,
          render: previewRender(outcome, assessment.tier, summary, [
            "Agents are paused company-wide. No action will be taken.",
          ]),
        };
      }

      const jti = randomUUID();

      if (outcome === "hold_for_approval") {
        const { token, payload } = issueToken(jti, hash, assessment.tier);
        const nowIso = new Date().toISOString();
        const { error } = await ctx.db.from("pending_approvals").insert({
          id: jti, // reuse jti as the row id so callers can reference either
          company_id: ctx.companyId,
          jti,
          action_type: `${resolved.kind}:${resolved.connector ?? "founders-os"}:${resolved.action ?? "action"}`,
          action_params: resolved.params ?? {},
          action_hash: hash,
          tier: assessment.tier,
          source,
          summary,
          status: "pending",
          token_expires_at: new Date(payload.exp * 1000).toISOString(),
          created_at: nowIso,
          updated_at: nowIso,
        });
        if (error) throw new Error(`Failed to record pending approval: ${error.message}`);

        await writeAuditLog(ctx, {
          action: "action_held",
          entity_type: "action",
          entity_id: jti,
          metadata: { tier: assessment.tier, source, summary, jti },
        });

        // Deliver the held action to a human: a native approval task is
        // created (guaranteed); a channel-agnostic message suggestion is
        // returned for the agent to dispatch through whatever messaging
        // tool the user has connected.
        const delivery = await deliverApproval(ctx, {
          id: jti,
          jti,
          summary,
          tier: assessment.tier,
          action_type: `${resolved.kind}:${resolved.connector ?? "founders-os"}:${resolved.action ?? "action"}`,
        });

        return {
          outcome,
          tier: assessment.tier,
          summary,
          reasons: assessment.reasons,
          approval_id: jti,
          confirm_token: token,
          held: true,
          delivery,
          // Echo the RESOLVED action back. The token is bound to the hash of
          // these resolved params, so execute_action must be called with this
          // exact object (not the pre-resolution input the caller may hold).
          resolved_action: resolved,
          risk_breakdown,
          render: previewRender(outcome, assessment.tier, summary, assessment.reasons),
        };
      }

      // allow / allow_with_log: no held row, but issue a token so
      // execute_action can verify the preview happened. No replay guard
      // exists for these tiers by design (accountability-first); reconcile
      // is the backstop.
      const { token } = issueToken(jti, hash, assessment.tier);
      return {
        outcome,
        tier: assessment.tier,
        summary,
        reasons: assessment.reasons,
        confirm_token: token,
        held: false,
        resolved_action: resolved,
        risk_breakdown,
        render: previewRender(outcome, assessment.tier, summary, assessment.reasons),
      };
    },
  },

  execute_action: {
    title: "Execute Action (clear to run)",
    description:
      "Verify that an action is cleared to run, then audit-log it. Pass the confirm_token from preview_action and echo back the resolved_action object that preview_action returned (NOT the pre-resolution input - the token is bound to the resolved params). For held tiers this refuses unless a human has approved the matching request, and it can only clear once (replay guard). On success it returns cleared: true - you then perform the actual connector call yourself; Founders OS records intent and approval but does not dispatch. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      confirm_token: z.string().describe("The token returned by preview_action (or reissued by approve_action)."),
      action: proposedActionSchema.describe("The resolved_action object returned by preview_action, echoed back exactly."),
    }),
    handler: async (
      ctx: ToolContext,
      { confirm_token, action }: { confirm_token: string; action: ProposedActionInput }
    ) => {
      const resolved = toProposedAction(action);
      const v = verifyToken(confirm_token);
      if (!v.valid) {
        throw new Error(`Confirm token ${v.reason}. Re-run preview_action.`);
      }
      const hash = actionHash(resolved);
      if (hash !== v.payload.action_hash) {
        throw new Error(
          "Action does not match the previewed action (hash mismatch). The token authorizes a different action."
        );
      }

      // Is there a held row for this jti? If so, it must be approved,
      // and the executed-flip is the replay guard.
      const { data: row, error } = await ctx.db
        .from("pending_approvals")
        .select("id, status, tier, summary, action_type")
        .eq("company_id", ctx.companyId)
        .eq("jti", v.payload.jti)
        .maybeSingle();
      if (error) throw new Error(`Failed to load approval: ${error.message}`);

      if (row) {
        if (row.status === "rejected") throw new Error("This action was rejected by a human and cannot run.");
        if (row.status === "executed") throw new Error("This action was already executed (replay refused).");
        if (row.status !== "approved") {
          throw new Error("This action is still awaiting human approval.");
        }
        // Atomic replay guard: flip approved -> executed only if still approved.
        const nowIso = new Date().toISOString();
        const { data: flipped, error: flipErr } = await ctx.db
          .from("pending_approvals")
          .update({ status: "executed", updated_at: nowIso })
          .eq("company_id", ctx.companyId)
          .eq("id", row.id)
          .eq("status", "approved")
          .select("id")
          .maybeSingle();
        if (flipErr) throw new Error(`Failed to mark executed: ${flipErr.message}`);
        if (!flipped) throw new Error("This action was already executed (replay refused).");

        await writeAuditLog(ctx, {
          action: "action_executed",
          entity_type: "action",
          entity_id: row.id,
          metadata: { tier: row.tier, jti: v.payload.jti, summary: row.summary, held: true },
        });

        return {
          cleared: true,
          jti: v.payload.jti,
          note: "Approved and cleared to run once. Perform the connector call now; this clearance will not be granted again.",
        };
      }

      // No held row: allow / allow_with_log tier. Token validity is enough.
      await writeAuditLog(ctx, {
        action: "action_executed",
        entity_type: "action",
        entity_id: hash,
        metadata: { tier: v.payload.tier, jti: v.payload.jti, held: false },
      });
      return {
        cleared: true,
        jti: v.payload.jti,
        note: "Cleared to run. Perform the connector call now.",
      };
    },
  },

  get_policy: {
    title: "Get Guardrail Policy",
    description:
      "Return the company's governance policy: the tier-to-outcome map, dry_run, and paused flags. Read-only. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({}),
    // Second param is required even though this tool takes no args:
    // registerToolMap treats handler.length < 2 as a legacy (no-ctx)
    // handler, so a one-arg contextual handler would be called without
    // ctx and crash on ctx.db. Keep the _args param to stay contextual.
    handler: async (ctx: ToolContext, _args: Record<string, never>) => {
      const policy = await loadPolicy(ctx);
      const md =
        "| Tier | Outcome |\n|---|---|\n" +
        (Object.keys(policy.tier_outcomes) as RiskTier[])
          .map((t) => `| ${t} | ${policy.tier_outcomes[t]} |`)
          .join("\n") +
        `\n\nDry-run: ${policy.dry_run} | Paused: ${policy.paused}`;
      return {
        policy,
        render: {
          tier_1: {
            format_hint: "table",
            instructions: {
              scope: "Render the tier-to-outcome map as a table, then show dry_run and paused.",
              format: "Two-column table. Show destructive and exfiltration rows in bold per the standard color conventions.",
              forbidden: "Do not imply the outcomes can be lowered for destructive/exfiltration; they are fixed at hold_for_approval.",
            },
          },
          tier_3: { markdown: md },
        } satisfies Render,
      };
    },
  },

  set_policy: {
    title: "Set Guardrail Policy",
    description:
      "Update the governance policy. Pass any of: tier_outcomes (a partial map of tier -> allow|allow_with_log|hold_for_approval), dry_run (hold and log every action), paused (kill switch). Refuses to lower destructive or exfiltration below hold_for_approval. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      tier_outcomes: z
        .record(z.string())
        .optional()
        .describe("Partial map, e.g. { external_write: 'allow_with_log' }. destructive/exfiltration cannot be lowered."),
      dry_run: z.boolean().optional().describe("When true, every action is held and logged regardless of tier."),
      paused: z.boolean().optional().describe("Company-wide kill switch. When true, every action returns the paused outcome. (pause_agents is the dedicated shortcut.)"),
    }),
    handler: async (
      ctx: ToolContext,
      { tier_outcomes, dry_run, paused }: { tier_outcomes?: Record<string, string>; dry_run?: boolean; paused?: boolean }
    ) => {
      const patch: { tier_outcomes?: ReturnType<typeof validateTierOutcomes>; dry_run?: boolean; paused?: boolean } = {};
      if (tier_outcomes) patch.tier_outcomes = validateTierOutcomes(tier_outcomes);
      if (dry_run !== undefined) patch.dry_run = dry_run;
      if (paused !== undefined) patch.paused = paused;
      const next = await savePolicy(ctx, patch);

      await writeAuditLog(ctx, {
        action: "guardrail_policy_updated",
        entity_type: "guardrail_policy",
        entity_id: ctx.companyId,
        after_state: { tier_outcomes: next.tier_outcomes, dry_run: next.dry_run, paused: next.paused },
        metadata: { changed: Object.keys(patch) },
      });

      return { success: true, policy: next };
    },
  },

  pause_agents: {
    title: "Pause Agents (kill switch)",
    description:
      "Set or clear the company-wide pause flag. When paused, preview_action returns a 'paused' outcome for every action and nothing is performed. Use to stop all agent action immediately. Pass paused: true to stop, false to resume.",
    parameters: z.object({
      paused: z.boolean().describe("true stops all agent action company-wide; false resumes normal policy."),
    }),
    handler: async (ctx: ToolContext, { paused }: { paused: boolean }) => {
      const next = await savePolicy(ctx, { paused });
      await writeAuditLog(ctx, {
        action: "guardrail_policy_updated",
        entity_type: "guardrail_policy",
        entity_id: ctx.companyId,
        after_state: { paused: next.paused },
        metadata: { changed: ["paused"], paused: next.paused },
      });
      return {
        success: true,
        paused: next.paused,
        note: next.paused ? "All agent action is paused company-wide." : "Agents resumed under the normal policy.",
      };
    },
  },

  list_pending_approvals: {
    title: "List Pending Approvals",
    description:
      "List actions that are held and waiting for a human to approve or reject. Read-only surface. Approval itself is a human action (approve_action is not available to the agent). Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({}),
    // Second param required to stay contextual; see get_policy note above.
    handler: async (ctx: ToolContext, _args: Record<string, never>) => {
      const { data, error } = await ctx.db
        .from("pending_approvals")
        .select("id, jti, action_type, action_params, action_hash, tier, source, summary, status, created_at")
        .eq("company_id", ctx.companyId)
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (error) throw new Error(`Failed to list pending approvals: ${error.message}`);
      const rows = (data ?? []) as PendingRow[];
      return { pending: rows, count: rows.length, render: pendingListRender(rows) };
    },
  },

  reconcile_actions: {
    title: "Reconcile Actions",
    description:
      "Diff a connector's recent activity against what the gate recorded, and flag any external side effect that has no matching approved-and-executed action as UNGOVERNED. Founders OS cannot pull connector activity itself, so you fetch the recent activity (e.g. messages the agent sent, charges it created) and pass it in. Where you stamped an approval's jti into the outbound call, pass it as `jti` for an exact match; otherwise reconcile falls back to a heuristic. Run this after acting. Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      connector: z.string().describe("The connector whose activity you fetched, e.g. 'slack' or 'stripe'."),
      activities: z.array(z.object({
        external_ref: z.string().describe("Connector-native id of the side effect (message ts, charge id, ...)."),
        summary: z.string().optional().describe("Plain description of the side effect."),
        observed_at: z.string().optional().describe("ISO timestamp the side effect was observed."),
        jti: z.string().optional().describe("The approval jti you stamped into the outbound call, if any (enables an exact match)."),
      })).describe("The recent connector activity attributed to the agent identity."),
    }),
    handler: async (ctx: ToolContext, { connector, activities }: { connector: string; activities: Array<{ external_ref: string; summary?: string; observed_at?: string; jti?: string }> }) => {
      const result = await reconcileActivities(ctx, connector, activities);
      const ungoverned = result.findings.filter((f) => f.status === "ungoverned");
      const md = ungoverned.length
        ? "**Off-book actions found:**\n" + ungoverned.map((f) => `- **UNGOVERNED** ${connector}: ${f.summary} (${f.external_ref})`).join("\n")
        : result.unverified > 0
          ? `${result.matched} verified, ${result.unverified} unverified (a governed action plausibly accounts for them, but without a stamped jti it cannot be proven). Nothing flagged off-book.`
          : `All ${result.matched} ${connector} side effect(s) reconciled to an approved action. Nothing off-book.`;
      return {
        connector,
        checked: activities.length,
        matched: result.matched,
        unverified_count: result.unverified,
        ungoverned_count: result.ungoverned,
        findings: result.findings,
        render: {
          tier_1: {
            format_hint: "incident",
            instructions: {
              scope: "Show the reconcile result. Lead with any ungoverned (off-book) side effects.",
              format: "Render ungoverned findings in BOLD RED per the standard color conventions; matched ones are neutral. If none are ungoverned, say so plainly.",
              forbidden: "Do not bury an ungoverned finding; it means an action happened without going through the gate.",
            },
          },
          tier_3: { markdown: md },
          do_not: ["Do not invent new color meanings; use the standard color conventions (red = danger)."],
        } satisfies Render,
      };
    },
  },

  list_reconciliation_findings: {
    title: "List Reconciliation Findings",
    description:
      "The 'anything off-book?' surface. Lists reconciliation findings, ungoverned (external side effects with no matching approved action) first. Pass status to filter ('ungoverned' default, 'unverified', 'matched', 'acknowledged', or 'all'). Response includes a render field with tiered rendering guidance - check it before composing your reply.",
    parameters: z.object({
      status: z.enum(["ungoverned", "unverified", "matched", "acknowledged", "all"]).optional().describe("Filter. Default 'ungoverned'."),
    }),
    handler: async (ctx: ToolContext, { status = "ungoverned" }: { status?: "ungoverned" | "unverified" | "matched" | "acknowledged" | "all" }) => {
      let q = ctx.db
        .from("reconciliation_findings")
        .select("id, connector, external_ref, observed_at, summary, matched_approval, status")
        .eq("company_id", ctx.companyId)
        .order("observed_at", { ascending: false });
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw new Error(`Failed to list reconciliation findings: ${error.message}`);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const md = rows.length
        ? "| Status | Connector | Summary | Observed |\n|---|---|---|---|\n" +
          rows.map((r) => `| ${r.status === "ungoverned" ? "**UNGOVERNED**" : r.status} | ${r.connector} | ${r.summary} | ${r.observed_at} |`).join("\n")
        : "No findings.";
      return {
        findings: rows,
        count: rows.length,
        render: {
          tier_1: {
            format_hint: "status_groups",
            instructions: {
              scope: "List findings grouped by status; ungoverned first.",
              format: "Render ungoverned rows in BOLD RED per the standard color conventions.",
              forbidden: "Do not hide ungoverned findings.",
            },
          },
          tier_3: { markdown: md },
          do_not: ["Do not invent new color meanings; use the standard color conventions."],
        } satisfies Render,
      };
    },
  },
};

export function registerGovernanceTools(server: McpServer, ctx: ToolContext): void {
  // NOTE: approveAction is intentionally NOT registered here. Approval is
  // a human-channel action; exposing it to the agent would let the same
  // session that proposes an action also approve it, collapsing the gate.
  registerToolMap(server, governanceTools, ctx);
}
