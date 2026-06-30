// ============================================================
// Founders OS — Connector capability + scope allowlist (T2.3, Layer 1)
// ============================================================
// Auto-dispatch is opt-in PER CONNECTOR. Even with a fresh clearance, the
// runner's hook only performs a connector write if the connector is enabled
// here, the verb is allowlisted, and (where a connector has a scope concept,
// e.g. a Slack channel) the target scope is allowed. This is enforced at the
// hook BEFORE verify-clearance, so a policy-denied call never burns a
// clearance.
//
// The policy is generic: each connector lists its permitted verbs and,
// optionally, a `scopeField` (the tool-input key naming the target, e.g.
// "channel") plus the `scopes` allowed for it. Founders-os never holds the
// connector credential — that lives in the runtime's MCP server config; this
// policy only governs which verbs/scopes the hook will clear.
// ============================================================

export interface ConnectorActionPolicy {
  /** Allowed connector verbs (the <action> in mcp__<connector>__<action>). */
  actions: string[];
  /** Optional: the tool-input field that names a scope (e.g. "channel"). */
  scopeField?: string;
  /** Optional: the allowed scope values; checked against input[scopeField]
   * when scopeField is set. Omit to allow any scope for the verb. */
  scopes?: string[];
}

/** Per-connector auto-dispatch policy, keyed by connector id (the MCP server
 * name, e.g. "slack"). A connector ABSENT from this map is not enabled for
 * auto-dispatch: its writes are denied at the hook and therefore stage. */
export type ConnectorPolicy = Record<string, ConnectorActionPolicy>;

export type CapabilityCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether a connector verb (and, if constrained, its target scope) is
 * permitted by the policy. Does NOT consult clearances — the hook runs this
 * first and only proceeds to verify-clearance when it returns ok.
 */
export function checkConnectorCapability(
  policy: ConnectorPolicy,
  connector: string,
  action: string,
  input: Record<string, unknown>
): CapabilityCheck {
  const cp = policy[connector];
  if (!cp) {
    return { ok: false, reason: `connector '${connector}' is not enabled for auto-dispatch` };
  }
  if (!cp.actions.includes(action)) {
    return { ok: false, reason: `verb '${action}' is not permitted for '${connector}'` };
  }
  if (cp.scopeField && cp.scopes) {
    const value = input[cp.scopeField];
    if (typeof value !== "string" || !cp.scopes.includes(value)) {
      return {
        ok: false,
        reason: `${cp.scopeField} '${String(value)}' is not in the allowed set for '${connector}'`,
      };
    }
  }
  return { ok: true };
}
