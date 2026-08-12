// ============================================================
// Founders OS - Environment Variable Reader
// ============================================================
// A single, defensive way to read a user-configurable env var.
//
// Why this exists: an env var that is present but BLANK is not
// a configured value, it is an unset one. Node makes this easy
// to get wrong because `process.env.X ?? DEFAULT` only falls
// back on undefined, so an empty string sails through and the
// default never fires.
//
// This is not a hypothetical. MCPB (the .mcpb bundle format used
// for one-click install in Claude Desktop and for Smithery local
// publishing) substitutes `${user_config.x}` with an EMPTY STRING
// when the user leaves an optional field blank in the install
// dialog. Every optional field we expose therefore arrives as ""
// rather than absent. Before this helper existed, a user who
// installed the bundle and filled in only the two required
// Supabase fields got a server that threw during startup:
// getCompanyId() failed the safe-identifier regex on "", and
// readEmbeddingConfigFromEnv() failed the provider whitelist on "".
//
// Rule: any env var a user can plausibly leave blank is read
// through readEnv(). OS-level vars we do not control (PATH, HOME)
// are exempt and keep their existing reads.
//
// Usage:
//   const raw = readEnv("FOUNDERS_OS_USER_ID") ?? DEFAULT_USER_ID;
// ============================================================

/**
 * Read an environment variable, treating blank as unset.
 *
 * Returns undefined when the variable is absent, empty, or contains
 * only whitespace. Otherwise returns the value with surrounding
 * whitespace trimmed, because a value pasted from a setup wizard or
 * an install dialog routinely carries a stray leading or trailing
 * space and every consumer here wants it gone.
 *
 * Pure. Safe to call at module scope or per request.
 */
export function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read an env var as a positive integer, treating blank as unset.
 *
 * Returns undefined when unset or blank. Throws with a named,
 * actionable message when the value is present but not a positive
 * integer, which is the behaviour every existing numeric env read
 * in this codebase already had; this just centralizes the message
 * and adds the blank-is-unset guarantee.
 */
export function readEnvInt(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer, got: "${raw}"`
    );
  }
  return parsed;
}
