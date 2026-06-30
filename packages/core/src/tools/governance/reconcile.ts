// ============================================================
// Founders OS — Reconcile (the accountability loop)
// ============================================================
// The gate cannot prevent an action, so reconcile is what converts
// "we cannot prevent" into "we will always find out." It takes the
// recent activity of a connector (Slack messages the agent sent, Stripe
// charges it created) and diffs it against what the gate recorded. Any
// external side effect with no matching governed action is flagged
// UNGOVERNED.
//
// THE GOVERNED RECORD HAS TWO HALVES, and reconcile reads BOTH:
//   - HELD tiers leave an `executed` pending_approvals row (a human
//     approved it, execute_action flipped it to executed).
//   - ALLOW / ALLOW_WITH_LOG tiers leave NO approval row - execute_action
//     records only an `action_executed` audit_log entry (held=false). A
//     founder may lower external_write to allow_with_log (a supported
//     move), so reconcile MUST account for these or it would false-flag a
//     properly gated allow-tier side effect as off-book.
//
// The server has no handle to the connector, so it cannot pull the
// activity itself: the AGENT fetches it and passes it in, exactly like
// report_trigger_observation. The diff and the findings are
// authoritative on the server.
//
// MATCHING:
//   - Exact (preferred): where a connector supports caller metadata or
//     an idempotency key, the agent stamps the approval's jti into the
//     outbound call. Reconcile then matches that jti to an executed
//     pending_approvals row. Cryptographic-ish proof of which approval
//     authorized the side effect.
//   - Heuristic (fallback): with no jti, match an executed approval for
//     the same connector. Best-effort; it stands alone but is fuzzy, so
//     it never blocks the exact path.
// ============================================================

import type { ToolContext } from "../../types/context.js";
import { writeAuditLog } from "../audit.js";

export interface ObservedActivity {
  /** Connector-native id of the side effect: a message ts, a charge id, etc. */
  external_ref: string;
  summary?: string;
  observed_at?: string;
  /** The approval jti the agent stamped into the outbound call, if any. */
  jti?: string;
}

export interface Finding {
  connector: string;
  external_ref: string;
  // matched    = exact proof (a stamped jti to an unused executed approval)
  // unverified = a plausible governed action exists but we cannot prove it
  //              is THIS side effect (no jti; heuristic by connector)
  // ungoverned = no governed action accounts for it
  status: "matched" | "unverified" | "ungoverned";
  matched_approval: string | null;
  summary: string;
}

interface ExecutedApproval {
  id: string;
  jti: string;
  action_type: string;
  summary: string;
}

/**
 * Diff a connector's observed activity against executed approvals and
 * write a reconciliation_findings row per side effect (idempotent via
 * the (company, connector, external_ref) unique key). Returns the
 * findings, ungoverned first.
 */
export async function reconcileActivities(
  ctx: ToolContext,
  connector: string,
  activities: ObservedActivity[]
): Promise<{ findings: Finding[]; matched: number; unverified: number; ungoverned: number }> {
  // Half 1: executed approvals (held tiers that a human cleared).
  const { data, error } = await ctx.db
    .from("pending_approvals")
    .select("id, jti, action_type, summary")
    .eq("company_id", ctx.companyId)
    .eq("status", "executed");
  if (error) throw new Error(`Failed to load executed approvals: ${error.message}`);
  const executedApprovals = (data ?? []) as ExecutedApproval[];

  // Half 2: allow-tier executions, which live only in the audit log
  // (execute_action's no-held-row branch writes action_executed with
  // held=false). Read via ctx.admin: audit_log is integrity-critical and
  // may be RLS-restricted from a user-scoped ctx.db in hosted mode, so we
  // read it the same way writeAuditLog writes it, scoped by company_id.
  // (Held executions also emit action_executed but with held=true; we keep
  // only held===false so they are not double-counted against Half 1.)
  // NOTE: this scans the company's action_executed history; audit_log
  // retention/partitioning (tracked separately) will bound it over time.
  const { data: auditData, error: auditErr } = await ctx.admin
    .from("audit_log")
    .select("entity_id, metadata")
    .eq("company_id", ctx.companyId)
    .eq("action", "action_executed");
  if (auditErr) throw new Error(`Failed to load allow-tier executions: ${auditErr.message}`);
  const allowTierExecutions: ExecutedApproval[] = (
    (auditData ?? []) as Array<{ entity_id: string; metadata: Record<string, unknown> | null }>
  )
    .filter((r) => r.metadata?.held === false && typeof r.metadata?.jti === "string")
    .map((r) => ({
      // Key on the jti (unique per action) so an allow-tier record can never
      // collide with a held approval's id and both consume independently.
      id: r.metadata!.jti as string,
      jti: r.metadata!.jti as string,
      action_type: (r.metadata!.action_type as string) ?? "",
      summary: (r.metadata!.summary as string) ?? "",
    }));

  // One pool of governed records to match observed side effects against.
  const executed = [...executedApprovals, ...allowTierExecutions];

  const byJti = new Map(executed.map((e) => [e.jti, e]));
  const connectorTag = `:${connector}:`;

  // Each executed approval authorizes ONE side effect, so an approval is
  // CONSUMED when it matches. Without consumption a single approval would
  // "cover" many off-book side effects and mask them. Exact (jti) matches
  // are consumed too, so a replayed jti on a second side effect does not
  // match a second time.
  const used = new Set<string>();

  const findings: Finding[] = [];
  for (const act of activities) {
    let match: ExecutedApproval | undefined;
    let status: Finding["status"];
    if (act.jti) {
      const candidate = byJti.get(act.jti);
      if (candidate && !used.has(candidate.id)) {
        match = candidate;
        used.add(candidate.id);
        status = "matched"; // exact proof, and not already consumed
      } else {
        // jti not found, or its approval was already consumed by another
        // side effect (a reused/forged jti). Neither is governed.
        status = "ungoverned";
      }
    } else {
      // No jti: at best a plausible governed action exists. Consume one
      // unused connector approval and mark UNVERIFIED, never "matched" -
      // we cannot prove this side effect is the one it authorized.
      const candidate = executed.find((e) => e.action_type.includes(connectorTag) && !used.has(e.id));
      if (candidate) {
        match = candidate;
        used.add(candidate.id);
        status = "unverified";
      } else {
        status = "ungoverned";
      }
    }
    const summary = act.summary ?? `${connector} activity ${act.external_ref}`;

    const { error: upErr } = await ctx.db.from("reconciliation_findings").upsert(
      {
        company_id: ctx.companyId,
        connector,
        external_ref: act.external_ref,
        observed_at: act.observed_at ?? new Date().toISOString(),
        summary,
        matched_approval: match?.id ?? null,
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "company_id,connector,external_ref" }
    );
    if (upErr) throw new Error(`Failed to write reconciliation finding: ${upErr.message}`);

    if (status === "ungoverned") {
      await writeAuditLog(ctx, {
        action: "reconcile_flagged",
        entity_type: "reconciliation",
        entity_id: act.external_ref,
        metadata: { connector, summary, had_jti: Boolean(act.jti) },
      });
    }
    findings.push({ connector, external_ref: act.external_ref, status, matched_approval: match?.id ?? null, summary });
  }

  const rank = (s: Finding["status"]) => (s === "ungoverned" ? 0 : s === "unverified" ? 1 : 2);
  findings.sort((a, b) => rank(a.status) - rank(b.status));
  return {
    findings,
    matched: findings.filter((f) => f.status === "matched").length,
    unverified: findings.filter((f) => f.status === "unverified").length,
    ungoverned: findings.filter((f) => f.status === "ungoverned").length,
  };
}

/**
 * Reconcile-at-dispatch (T2.4). When the runner hook clears and performs a
 * connector write, it records the match HERE, immediately, instead of
 * relying on a later report_trigger_observation / reconcile_actions fetch.
 * The finding is `matched` and points at the consumed clearance (jti). Its
 * external_ref is synthetic (`dispatch:<jti>`) because canUseTool runs before
 * the connector returns its native id; the governance fact ("this send was
 * cleared through the gate") is what the record certifies. Idempotent via the
 * (company, connector, external_ref) unique key.
 */
export async function recordDispatchFinding(
  ctx: ToolContext,
  params: { connector: string; jti: string; summary: string }
): Promise<void> {
  const { connector, jti, summary } = params;
  const nowIso = new Date().toISOString();
  const { error } = await ctx.db.from("reconciliation_findings").upsert(
    {
      company_id: ctx.companyId,
      connector,
      external_ref: `dispatch:${jti}`,
      observed_at: nowIso,
      summary,
      matched_approval: jti,
      status: "matched",
      updated_at: nowIso,
    },
    { onConflict: "company_id,connector,external_ref" }
  );
  if (error) throw new Error(`Failed to record dispatch finding: ${error.message}`);
}
