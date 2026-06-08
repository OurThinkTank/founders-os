// ============================================================
// Founders OS - First-Run Detection
// ============================================================
// Shared helper that checks whether the database has any
// meaningful user data. Used by likely-first-contact tools to
// attach an onboarding hint when the install is fresh.
//
// Caching strategy:
//   - Once data is detected (false), cache permanently for the
//     process lifetime - data doesn't disappear.
//   - While empty (true), re-check on every call so we pick up
//     the user's first insert immediately.
//   - On query failure (unreachable DB, demo mode), return true.
//     The hint is helpful regardless and harmless at worst.
// ============================================================

import { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_USER_ID } from "../utils/identity.js";

let resolved = false;
let cachedResult = false;

/**
 * Returns true if the database has no meaningful user data.
 * Checks four tables using whatever scoping each table supports:
 *   - customers: no company_id column in schema (single-tenant per DB); counts all rows
 *   - tasks: scoped by company_id
 *   - financial_transactions: scoped by company_id
 *   - memories: no company_id column; scoped by user_id (personal + org) as best effort
 *
 * Multi-tenant note: the customers table has no company_id column (verified against
 * migration 001_crm_schema.sql), so it cannot be filtered per-company. In a shared
 * multi-tenant deployment this means an existing customer from another company would
 * suppress the first-run hint — acceptable given the current schema design. The memories
 * query is scoped to the current user's rows (personal and org) to reduce cross-tenant
 * contamination as much as the schema permits.
 *
 * Result is cached permanently after the first `false` return.
 */
export async function detectFirstRun(
  supabase: SupabaseClient,
  companyId: string
): Promise<boolean> {
  if (resolved) return cachedResult;

  // Match the user identity convention used by the memory tool
  const userId = process.env.FOUNDERS_OS_USER_ID ?? DEFAULT_USER_ID;

  try {
    const counts = await Promise.all([
      // customers has no company_id column — counts all rows in the DB
      supabase
        .from("customers")
        .select("id", { count: "exact", head: true })
        .is("deleted_at", null),
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .is("deleted_at", null),
      supabase
        .from("financial_transactions")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .is("deleted_at", null),
      // memories scoped by company_id (migration 037) plus this user's
      // personal + org entries
      supabase
        .from("memories")
        .select("id", { count: "exact", head: true })
        .eq("company_id", companyId)
        .or(`user_id.eq.${userId},user_id.eq.org`),
    ]);

    const totalRows = counts.reduce(
      (sum, res) => sum + (res.count ?? 0),
      0
    );

    cachedResult = totalRows === 0;
  } catch {
    // DB unreachable (demo mode, network issue, etc.)
    // Treat as first-run - the hint is helpful regardless.
    cachedResult = true;
  }

  // Only cache permanently when data exists.
  if (!cachedResult) resolved = true;

  return cachedResult;
}

/** The hint string attached to tool responses on first run. */
export const FIRST_RUN_HINT =
  "This appears to be a fresh Founders OS install with no data yet. " +
  "Consider asking the user if they'd like a guided walkthrough, or suggest " +
  "running show_capabilities to see what's possible. Don't hijack their " +
  "request - answer it first, then offer the tour.";
