// ============================================================
// Founders OS — Search Query Sanitizer
// ============================================================
// Strips PostgREST structural characters from user-supplied
// search strings before they are interpolated into .or() filter
// expressions such as:
//
//   .or(`organization_name.ilike.%${query}%,city.ilike.%${query}%`)
//
// PostgREST parses the .or() argument as a mini-language where
// commas separate clauses and parentheses introduce nested groups.
// Injecting those characters through the query parameter can
// corrupt the filter syntax or add unintended filter clauses.
//
// Allowed characters (sufficient for name / email / org searches):
//   a–z  A–Z  0–9  space  @  .  _  -
// Everything else is stripped. Max length is capped at maxLen
// (default 100, matching the Zod schemas on the callers).
// ============================================================

/**
 * Sanitize a user-supplied search query before interpolating it
 * into a PostgREST filter string.
 *
 * @param raw    Raw query string from the tool parameter.
 * @param maxLen Maximum allowed length (characters beyond this are truncated).
 * @returns      A string safe for use inside a PostgREST ilike value.
 */
export function sanitizeSearchQuery(raw: string, maxLen = 100): string {
  return raw
    .slice(0, maxLen)                     // enforce length cap first
    .replace(/[^a-zA-Z0-9 @._\-]/g, ""); // strip unsafe characters
}
