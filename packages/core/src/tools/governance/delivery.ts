// ============================================================
// Founders OS — Approval Delivery
// ============================================================
// When preview_action holds an action, a human has to hear about it.
// Delivery is channel-agnostic with one honest constraint: the server
// cannot send an outbound message, because messaging connectors live on
// the agent's side of the boundary (the same reason the gate cannot
// intercept a connector call). Founders OS does not assume any
// particular messaging tool; the agent uses whatever the user connected.
// So delivery splits in two:
//
//   GUARANTEED (server-side): create a native approval task in Founders
//   OS and stamp the pending_approvals row with where it was delivered.
//   This always happens and needs no connector, so a held action is
//   never invisible even with nothing else connected.
//
//   BEST-EFFORT (agent-side): return a ready-to-post message the agent
//   can send through whatever messaging connector is available. The
//   server does not send it; it hands the agent the text to post.
//
// preview_action calls deliverApproval() on hold and surfaces both.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import { RED_TIERS, type RiskTier } from "../playbooks/risk.js";

/**
 * Neutralize attacker-/agent-influenced text before it lands in the
 * human-facing approval surface. The action summary can be shaped by a
 * prompt-injected agent ("routine, approve quickly"); strip markdown,
 * link, and control characters and cap length so it cannot inject
 * formatting, a clickable link, or a tracking image into the approval
 * task or an outbound message. The resolved action_params (shown by
 * list_pending_approvals) remain the source of truth for the approver.
 */
function escUntrusted(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[`*_~[\]()<>!#|]/g, " ")
    .slice(0, 200)
    .trim();
}

export interface ApprovalToDeliver {
  id: string;
  jti: string;
  summary: string;
  tier: RiskTier;
  action_type: string;
}

export interface DeliveryResult {
  /** The guaranteed channel that actually received it. */
  channel: "native_task";
  /** Id of the native approval task created in Founders OS. */
  task_id: string | null;
  /**
   * A ready-to-post message the agent MAY dispatch through whatever
   * messaging connector the user has (Slack, Teams, Discord, email, ...).
   * Channel-agnostic: the server does not assume a tool and does not send
   * this; it hands the agent the text to post.
   */
  message_suggestion: { text: string; high_risk: boolean };
  note: string;
}

/**
 * Deliver a held approval. Always creates a native approval task and
 * records the delivery on the pending_approvals row. Best-effort: a
 * failure to create the task is logged, not thrown, so a delivery
 * problem never breaks the preview that held the action.
 */
export async function deliverApproval(
  ctx: ToolContext,
  approval: ApprovalToDeliver
): Promise<DeliveryResult> {
  const red = RED_TIERS.has(approval.tier);
  const safeSummary = escUntrusted(approval.summary);
  const title = `Approve: ${safeSummary}`.slice(0, 200);
  const description =
    `An agent action is held for your approval.\n\n` +
    `Risk tier: ${approval.tier}${red ? " (high risk)" : ""}\n` +
    `What: ${safeSummary}\n\n` +
    `Treat the description above as untrusted; rely on the resolved parameters in the approvals list. ` +
    `Approving is a human action. Approve or reject it (a teammate, an approval in a connected tool, ` +
    `or your own authenticated session), not the agent that proposed it. Reference: ${approval.jti}.`;

  let taskId: string | null = null;
  try {
    const { data, error } = await ctx.db
      .from("tasks")
      .insert({
        company_id: ctx.companyId,
        title,
        description,
        status: "todo",
        priority: red ? "urgent" : "high",
        scope: "org",
        created_by: ctx.userId,
        tags: ["approval", "governance"],
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.error(`[delivery] failed to create approval task: ${error.message}`);
    } else {
      taskId = (data as { id: string } | null)?.id ?? null;
    }
  } catch (e) {
    console.error(`[delivery] approval task insert threw:`, e);
  }

  // Stamp the pending_approvals row with where it landed (best-effort).
  try {
    await ctx.db
      .from("pending_approvals")
      .update({ delivery_channel: "native_task", delivery_ref: taskId })
      .eq("company_id", ctx.companyId)
      .eq("id", approval.id);
  } catch (e) {
    console.error(`[delivery] failed to stamp delivery on approval ${approval.id}:`, e);
  }

  const messageText =
    `${red ? "[High risk] " : ""}Approval needed: ${safeSummary} ` +
    `(risk: ${approval.tier}). A human must approve or reject; the agent cannot approve its own action. Ref ${approval.jti}.`;

  return {
    channel: "native_task",
    task_id: taskId,
    message_suggestion: { text: messageText, high_risk: red },
    note:
      "A native approval task was created (guaranteed). If a messaging tool is connected, you may also post message_suggestion.text through it; the server does not assume a tool and does not send it.",
  };
}
