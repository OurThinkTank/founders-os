// ============================================================
// Founders OS - Validated Identity Helpers
// ============================================================
// Centralizes reading of FOUNDERS_OS_USER_ID and
// FOUNDERS_OS_COMPANY_ID env vars with strict validation.
//
// Why validation matters: several tools interpolate these values
// into PostgREST .or() filter strings. Characters like commas,
// parentheses, or dots can corrupt the filter grammar or widen
// query scope. We restrict IDs to safe identifier characters
// and throw loudly on misconfiguration rather than silently
// producing broken filters.
//
// Usage: import { getUserId, getCompanyId } from "../../utils/identity.js";
// (replaces the per-file `function getUserId()` pattern)
// ============================================================

const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ── Placeholder identity ─────────────────────────────────────
// The values a fresh install runs as before the operator sets
// FOUNDERS_OS_USER_ID / FOUNDERS_OS_COMPANY_ID. Deliberately
// memorable and obviously-fake so a new user notices they should
// change them (unlike the old bland "default"). These same values
// double as the solo-mode sentinels: running as both placeholders
// means no identity has been configured, which is exactly solo mode.
//
// IMPORTANT: these are the application-layer fallbacks. The DB column
// DEFAULTs are a separate, deeper failsafe and are currently an
// inconsistent mix ('default' / 'ourthinktank'). They get normalized
// to DEFAULT_COMPANY_ID during the pre-1.0 migration consolidation;
// until then they almost never fire because every insert passes
// ctx.companyId explicitly. See the placeholder-identity design memory.
export const DEFAULT_USER_ID = "foundersuser1";
export const DEFAULT_COMPANY_ID = "myawesomecompany";

function validateId(value: string, envVar: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `${envVar} contains unsafe characters: "${value}". ` +
      `Only a-z, A-Z, 0-9, underscore, and hyphen are allowed. ` +
      `This value is interpolated into PostgREST filters and must be a safe identifier.`
    );
  }
  return value;
}

/** Validated caller user ID. Throws if the env var contains unsafe characters. */
export function getUserId(): string {
  const raw = process.env.FOUNDERS_OS_USER_ID ?? DEFAULT_USER_ID;
  return validateId(raw, "FOUNDERS_OS_USER_ID");
}

/** Validated company ID. Throws if the env var contains unsafe characters. */
export function getCompanyId(): string {
  const raw = process.env.FOUNDERS_OS_COMPANY_ID ?? DEFAULT_COMPANY_ID;
  return validateId(raw, "FOUNDERS_OS_COMPANY_ID");
}

/**
 * Returns true when the server is running in solo mode:
 * no explicit user ID or company ID has been configured,
 * so both resolve to their placeholders. Used by members and
 * financial access tools to skip multi-user permission checks.
 */
export function isSoloMode(): boolean {
  return getUserId() === DEFAULT_USER_ID && getCompanyId() === DEFAULT_COMPANY_ID;
}

/**
 * Returns true when EITHER identity value is still the placeholder,
 * i.e. the operator has not finished configuring their identity.
 * Broader than isSoloMode (which requires both): a user who set a
 * company but not a username should still be nudged. Pure / no DB.
 */
export function isPlaceholderIdentity(): boolean {
  return getUserId() === DEFAULT_USER_ID || getCompanyId() === DEFAULT_COMPANY_ID;
}

/**
 * A one-line nudge to surface when the operator is still on a
 * placeholder identity, or null when both values are configured.
 * Tools that orient the user (get_session_start, show_capabilities)
 * attach this so a fresh install is reminded to claim its identity.
 */
export function getPlaceholderIdentityHint(): string | null {
  if (!isPlaceholderIdentity()) return null;
  const onUser = getUserId() === DEFAULT_USER_ID;
  const onCompany = getCompanyId() === DEFAULT_COMPANY_ID;
  const which =
    onUser && onCompany
      ? `the sample identity (FOUNDERS_OS_USER_ID="${DEFAULT_USER_ID}", FOUNDERS_OS_COMPANY_ID="${DEFAULT_COMPANY_ID}")`
      : onUser
        ? `the sample username (FOUNDERS_OS_USER_ID="${DEFAULT_USER_ID}")`
        : `the sample company id (FOUNDERS_OS_COMPANY_ID="${DEFAULT_COMPANY_ID}")`;
  return (
    `Heads up: this install is still using ${which}. ` +
    `Set the env var(s) to your own values so your data is filed under your own identity. ` +
    `Mention this to the user once, conversationally, then continue with their request.`
  );
}
