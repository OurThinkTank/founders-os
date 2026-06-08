// ============================================================
// Founders OS - ToolContext Lint
// ============================================================
// Ratchet test that drives the env-vars-out-of-handlers migration.
// See docs/multi-deployment-architecture.md for the design and
// docs/oss-launch-plan.md "Post-Launch Foundation Work" for the
// rollout plan.
//
// What this enforces:
//
//   * Every source file in CONTEXTUAL_FILES is "migrated": its
//     handlers receive a ToolContext and MUST NOT call
//     createServiceClient(), getCompanyId(), or getUserId()
//     directly in their bodies.
//
//   * Every other tool file is still on the legacy pattern; this
//     test does not block them. It only ratchets: as a file
//     migrates, add it to CONTEXTUAL_FILES; from then on the lint
//     enforces no regression.
//
// How to add a file after migration:
//
//   1. Refactor every handler in the file to take (ctx, params).
//   2. Replace createServiceClient() / getCompanyId() / getUserId()
//      calls inside handler bodies with ctx.db / ctx.companyId /
//      ctx.userId.
//   3. Add the file's repo-relative path to CONTEXTUAL_FILES below.
//   4. Run this test. It should pass.
//
// What "legitimately privileged" looks like:
//
//   Some operations (audit-log writes, background jobs) need to
//   bypass RLS even under hosted mode and call ctx.admin instead
//   of ctx.db. That is allowed and not flagged by this test. If
//   you need direct createServiceClient() access AFTER migration
//   for some reason, file an exception comment with `// lint:
//   tool-context allow-direct-client` on the call line and a
//   reason. The lint will skip it. Use sparingly.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, "..");

/**
 * Files that have been migrated to the ToolContext pattern.
 * Paths are relative to packages/mcp-server/src/.
 *
 * KEEP THIS LIST SORTED. Add files as they migrate. Do not remove
 * files unless you are intentionally reverting a migration (rare;
 * almost certainly the wrong move).
 */
const CONTEXTUAL_FILES = [
  // CRM (fully migrated 2026-05-28)
  "tools/crm/contacts.ts",
  "tools/crm/customers.ts",
  "tools/crm/dashboard.ts",
  "tools/crm/interactions.ts",
  // Financial (handlers fully migrated 2026-05-28; access.ts helpers
  // still env-reading - tracked as deferred work in oss-launch-plan.md)
  "tools/financial/index.ts",
  "tools/financial/management.ts",
  // Members (fully migrated 2026-05-28; financial/access.ts and
  // audit.ts helpers still env-reading - tracked as deferred work)
  "tools/members/index.ts",
  // Memory (fully migrated 2026-05-28; embed.ts helper still env-reading,
  // tracked alongside the broader helper-refactor in oss-launch-plan.md)
  "tools/memory/index.ts",
  // Playbooks (fully migrated 2026-05-28; audit.ts helper still env-reading,
  // tracked as deferred work)
  "tools/playbooks/index.ts",
  // Projects (fully migrated 2026-05-28)
  "tools/projects/index.ts",
  // Restore (fully migrated 2026-05-28 alongside permissions.ts helper refactor)
  "tools/restore.ts",
  // RSS (fully migrated 2026-05-28)
  "tools/rss/bookmarks.ts",
  "tools/rss/briefing.ts",
  "tools/rss/feeds.ts",
  "tools/rss/items.ts",
  // Surfaces (fully migrated 2026-05-28)
  "tools/surfaces/index.ts",
  // Tags (fully migrated 2026-05-28 alongside the validateTags helper refactor)
  "tools/tags/index.ts",
  // Tasks (fully migrated 2026-05-28)
  "tools/tasks/index.ts",
] as const;

/**
 * Helper-only files that the lint must also scan. These files
 * export shared functions consumed by tool handlers but do not
 * declare handlers themselves, so the CONTEXTUAL_FILES guard
 * (which requires at least one `handler: async (ctx, ...)` line)
 * cannot cover them. The rule for HELPER_FILES is stricter:
 * forbidden tokens must not appear ANYWHERE in the file body,
 * not just inside handlers.
 *
 * Added after the access.ts / permissions.ts refactor of
 * 2026-05-28 to lock in their fully-contextual shape.
 */
const HELPER_FILES = [
  "tools/audit.ts",
  "tools/financial/access.ts",
  "tools/memory/embed.ts",
  "tools/permissions.ts",
  "tools/remove.ts",
] as const;

/**
 * Tokens that contextual handlers must not contain. Each token is
 * a function name; matching is literal substring against the handler
 * body extracted between { and the closing brace of the handler arrow.
 *
 * Note: top-level imports are NOT flagged. A file in CONTEXTUAL_FILES
 * can still import createServiceClient (for now) because other tools
 * in the same file may not yet be migrated. Once an entire file's
 * tools are migrated, the import itself can be removed by the author
 * (separate cleanup PR), which this lint does not require.
 */
const FORBIDDEN_IN_HANDLER_BODY = [
  "createServiceClient(",
  "getCompanyId(",
  "getUserId(",
] as const;

const EXCEPTION_MARKER = "lint: tool-context allow-direct-client";

/**
 * Walk the source of one file and find every `handler: async (ctx,`
 * declaration. Return the body text of each handler so we can scan
 * for forbidden tokens.
 *
 * This is a simple text scan, not a real AST walk. It looks for
 * the literal `handler: async (ctx` to identify contextual handlers,
 * then collects characters between the opening `{` of the arrow body
 * and the matching closing `}` using brace depth tracking. Sufficient
 * for the structure used by Pattern A tool maps in this codebase.
 *
 * Returns an array of { startLine, body } so violations can be
 * reported with a line number.
 */
function extractContextualHandlerBodies(
  source: string
): Array<{ startLine: number; body: string }> {
  const bodies: Array<{ startLine: number; body: string }> = [];
  const lines = source.split("\n");

  // Find every `handler: async (ctx` occurrence.
  for (let i = 0; i < lines.length; i++) {
    // Match `handler: async (ctx` and also `handler: async (ctx:` etc.
    if (!/handler:\s*async\s*\(\s*ctx[:\s,)]/.test(lines[i])) continue;

    // Walk forward from this line, counting braces, until we find
    // the body's opening `{` (after the closing `)` of the params).
    let pos = source.indexOf(lines[i]);
    if (pos === -1) continue;
    // Move past the `(ctx, params)` part to find the `=>` and then `{`.
    const arrowIdx = source.indexOf("=>", pos);
    if (arrowIdx === -1) continue;
    const bodyStart = source.indexOf("{", arrowIdx);
    if (bodyStart === -1) continue;

    let depth = 1;
    let cursor = bodyStart + 1;
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      cursor++;
    }
    if (depth !== 0) continue; // unbalanced; skip silently

    bodies.push({
      startLine: i + 1,
      body: source.slice(bodyStart + 1, cursor - 1),
    });
  }

  return bodies;
}

describe("ToolContext lint - contextual handlers must not bypass ctx", () => {
  for (const relPath of CONTEXTUAL_FILES) {
    it(`${relPath}: no env/client calls inside contextual handler bodies`, () => {
      const absPath = resolve(SRC, relPath);
      const source = readFileSync(absPath, "utf-8");
      const handlers = extractContextualHandlerBodies(source);

      // It's an error if a file is in the allowlist but has NO
      // contextual handlers - the file probably regressed.
      expect(
        handlers.length,
        `${relPath} is listed in CONTEXTUAL_FILES but contains no ` +
          `handlers declared with (ctx, ...). Did a migration regress?`
      ).toBeGreaterThan(0);

      const violations: string[] = [];
      for (const { startLine, body } of handlers) {
        for (const forbidden of FORBIDDEN_IN_HANDLER_BODY) {
          const idx = body.indexOf(forbidden);
          if (idx === -1) continue;
          // Find the line within the body that contains the match.
          const before = body.slice(0, idx);
          const lineInBody = before.split("\n").length - 1;
          const offendingLine = body.split("\n")[lineInBody] ?? "";
          if (offendingLine.includes(EXCEPTION_MARKER)) continue;
          violations.push(
            `  Line ~${startLine + lineInBody}: ${forbidden} - ` +
              `replace with ctx.db / ctx.companyId / ctx.userId`
          );
        }
      }

      expect(
        violations,
        `${relPath} has contextual handlers that still call env / client ` +
          `helpers directly:\n${violations.join("\n")}\n\n` +
          `Fix by using ctx.db, ctx.companyId, ctx.userId. If a bypass is ` +
          `genuinely required (admin operation, audit write), add the ` +
          `comment '// ${EXCEPTION_MARKER}' on the call line with a reason.`
      ).toHaveLength(0);
    });
  }

  it("CONTEXTUAL_FILES list stays sorted (catches merge ordering bugs)", () => {
    const sorted = [...CONTEXTUAL_FILES].sort();
    expect(CONTEXTUAL_FILES).toEqual(sorted);
  });
});

describe("ToolContext lint - helper-only files must not read env vars", () => {
  for (const relPath of HELPER_FILES) {
    it(`${relPath}: no env/client tokens anywhere in the file`, () => {
      const absPath = resolve(SRC, relPath);
      const source = readFileSync(absPath, "utf-8");
      const lines = source.split("\n");

      const violations: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Allow forbidden tokens in comments (the helpers' own docstrings
        // reference these names when explaining the legacy pattern).
        const stripped = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (line.includes(EXCEPTION_MARKER)) continue;
        for (const forbidden of FORBIDDEN_IN_HANDLER_BODY) {
          if (stripped.includes(forbidden)) {
            violations.push(`  Line ${i + 1}: ${forbidden}`);
          }
        }
      }

      expect(
        violations,
        `${relPath} is a HELPER_FILES entry but still calls env / client ` +
          `helpers directly:\n${violations.join("\n")}\n\n` +
          `Helpers consumed by contextual handlers must take ToolContext ` +
          `and use ctx.db / ctx.companyId / ctx.userId.`
      ).toHaveLength(0);
    });
  }

  it("HELPER_FILES list stays sorted (catches merge ordering bugs)", () => {
    const sorted = [...HELPER_FILES].sort();
    expect(HELPER_FILES).toEqual(sorted);
  });
});
