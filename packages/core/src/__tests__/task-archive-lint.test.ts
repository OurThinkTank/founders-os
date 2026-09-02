// Fails when a read of the tasks table can return archived rows.
// Reads must go through liveTasks() from tools/filters.ts. The tools
// listed in ALLOWED are exempt because they need archived rows.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, "..");
const TOOLS = resolve(SRC, "tools");

/**
 * Reads that must still return archived tasks, as "<file>:<tool>".
 * A bare "<file>" exempts every tasks read in that file.
 *
 * KEEP SORTED. To add an entry, say in the PR why the read needs
 * archived rows.
 */
const ALLOWED = new Set([
  // Fetch by id: an archived task stays addressable so it can be
  // inspected or restored. Includes the blocker lookups.
  "tools/tasks/index.ts:add_task_note",
  "tools/tasks/index.ts:complete_task",
  "tools/tasks/index.ts:get_task",
  "tools/tasks/index.ts:link_task",
  "tools/tasks/index.ts:remove_task",
  "tools/tasks/index.ts:unlink_task",
  // Tag cascade counts: the cascade rewrites archived rows too, so
  // the count shown for approval has to include them.
  "tools/projects/index.ts:create_project",
  "tools/projects/index.ts:update_project",
  "tools/tags/index.ts:remove_tag",
  "tools/tags/index.ts:rename_tag",
  // A record of work finished in the window, not a live-work view.
  "tools/surfaces/index.ts:get_weekly_retro",
  // Counts rows to answer "has this install been used".
  "tools/first-run.ts",
]);

/** filters.ts defines liveTasks() itself. */
const SELF = ["filters.ts"];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith(".ts") && !SELF.includes(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The ToolMap key a line sits under, or null outside any tool.
 * Text scan, not an AST walk, matching tool-context-lint.test.ts.
 */
function enclosingTool(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const match = /^ {2}([a-z_]+):\s*\{/.exec(lines[i]);
    if (match) return match[1];
  }
  return null;
}

/** Every `.from("tasks")` with the statement it belongs to. */
function taskQueries(source: string) {
  const lines = source.split("\n");
  const found: Array<{ line: number; tool: string | null; block: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('.from("tasks")')) continue;

    let end = i;
    while (end < lines.length - 1 && !lines[end].includes(";") && end - i < 25) end++;

    found.push({
      line: i + 1,
      tool: enclosingTool(lines, i),
      block: lines.slice(i, end + 1).join("\n"),
    });
  }

  return found;
}

describe("task archive lint", () => {
  const files = tsFiles(TOOLS);

  it("finds tool sources to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const absPath of files) {
    const relPath = relative(SRC, absPath).split(sep).join("/");
    const source = readFileSync(absPath, "utf8");
    const queries = taskQueries(source);
    if (queries.length === 0) continue;

    it(`${relPath}: tasks reads exclude archived rows`, () => {
      const violations: string[] = [];

      for (const q of queries) {
        // Writes address a row by id and must still reach archived tasks.
        const isRead = q.block.includes(".select(");
        const isWrite = /\.(insert|update|delete|upsert)\(/.test(q.block);
        if (!isRead || isWrite) continue;

        if (q.block.includes('is("archived_at", null)')) continue;
        if (ALLOWED.has(relPath)) continue;
        if (q.tool && ALLOWED.has(`${relPath}:${q.tool}`)) continue;

        violations.push(
          `${relPath}:${q.line} (${q.tool ?? "no tool"}) reads tasks without ` +
            `excluding archived rows. Use liveTasks() from tools/filters.js, ` +
            `or add it to ALLOWED in this test with a reason.`
        );
      }

      expect(violations).toEqual([]);
    });
  }
});
