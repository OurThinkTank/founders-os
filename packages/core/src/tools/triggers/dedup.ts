// ============================================================
// Founders OS — Trigger Dedup
// ============================================================
// A watcher is only useful if it fires once when a situation becomes
// true, not every time the clock ticks. Dedup is the difference between
// a signal and an alarm everyone mutes.
//
// The fingerprint is hash(sorted matching row ids + a per-condition
// MATERIAL STATE FIELD). The state field is what makes a *worsening*
// situation re-fire: a deal that slips from the 7-day bucket to the
// 30-day bucket has the same row id but a different state value, so the
// fingerprint changes and the trigger fires again. A situation that is
// merely still true (same rows, same bucket) does not re-fire.
//
// Pure module: no DB, no env. The SAME function computes the
// fingerprint whether the rows came from server SQL (data conditions)
// or from the agent via report_trigger_observation (connector
// conditions), so dedup behaves identically across both sources.
// ============================================================

import { createHash } from "node:crypto";

/**
 * Compute the dedup fingerprint for a set of matching rows plus the
 * condition's material state value.
 *
 *   - rowIds: the ids of the rows that currently match the condition.
 *     Order does not matter; they are sorted before hashing so the same
 *     set always produces the same fingerprint.
 *   - stateField: the per-condition material state (e.g. a days-stalled
 *     bucket label, a crossed-threshold step, the latest matched item
 *     id). When the situation worsens, this value changes and the
 *     fingerprint changes even if the row ids are unchanged.
 *
 * An empty match set yields a stable "empty" fingerprint distinct from
 * any non-empty set, so a condition that goes from matching to not
 * matching and back will re-fire.
 */
export function fingerprint(
  rowIds: ReadonlyArray<string>,
  stateField: string | number | null | undefined
): string {
  const ids = [...rowIds].map((x) => String(x)).sort();
  const state = stateField === null || stateField === undefined ? "" : String(stateField);
  const canonical = JSON.stringify({ ids, state });
  return "fp:" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Has the situation changed since we last fired? True when the stored
 * last_state differs from the freshly computed fingerprint (including
 * the first-ever evaluation, where last_state is null/undefined).
 *
 * A fingerprint that matches last_state means "same situation, already
 * handled" and must NOT re-fire.
 */
export function changed(
  lastState: string | null | undefined,
  freshFingerprint: string
): boolean {
  return (lastState ?? "") !== freshFingerprint;
}
