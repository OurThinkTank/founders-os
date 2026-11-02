// Fails when a read of the tasks table can return another user's personal
// tasks. Reads must go through visibleTasks() or findVisibleTask() from
// tools/filters.ts, or apply taskVisibilityFilter(). In tools/restore.ts a
// read of a table picked at run time, e.g. .from(config.table), must go
// through visibleRows(). A read that does not show task data to the caller
// can carry an allow marker on one of the three lines above it:
//
//   // task-visibility-lint: allow - <reason>

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, "..");
const TOOLS = resolve(SRC, "tools");

/** filters.ts defines the visibility helpers themselves. */
const SELF = ["filters.ts"];

const MARKER = /\/\/ task-visibility-lint: allow - \S/;

/** Files where a read of a table picked at run time can return tasks. */
const DYNAMIC_TABLE_FILES = ["tools/restore.ts"];

/** A read of a table picked at run time, e.g. .from(config.table). */
const DYNAMIC_FROM = /\.from\(\s*[^"'`\s)]/;

/** An embedded tasks read, e.g. .select("tasks(*)") on a junction table. */
const EMBED = /\.select\(\s*["'`][^"'`]*\btasks(!\w+)?\s*\(/;

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

/** The statement a line starts, up to its semicolon or 25 lines. */
function statementFrom(lines: string[], i: number): string {
  let end = i;
  while (end < lines.length - 1 && !lines[end].includes(";") && end - i < 25) end++;
  return lines.slice(i, end + 1).join("\n");
}

function hasMarker(lines: string[], i: number): boolean {
  return lines.slice(Math.max(0, i - 3), i + 1).some((l) => MARKER.test(l));
}

/** Every tasks read in a file that skips the visibility rule. */
function violations(relPath: string, source: string): string[] {
  const lines = source.split("\n");
  const found: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("import ")) continue;

    if (/\bliveTasks\(/.test(line) && !hasMarker(lines, i)) {
      found.push(
        `${relPath}:${i + 1} calls liveTasks() directly. Use visibleTasks() ` +
          `from tools/filters.js, or add an allow marker with a reason.`
      );
      continue;
    }

    if (DYNAMIC_TABLE_FILES.includes(relPath) && DYNAMIC_FROM.test(line)) {
      const block = lines.slice(Math.max(0, i - 2), i).join("\n") + "\n" + statementFrom(lines, i);
      const isRead = block.includes(".select(");
      const isWrite = /\.(insert|update|delete|upsert)\(/.test(block);
      if (!isRead || isWrite || block.includes("visibleRows(") || hasMarker(lines, i)) continue;
      found.push(
        `${relPath}:${i + 1} reads a table picked at run time without the ` +
          `visibility rule. Wrap the read in visibleRows(), or add an allow ` +
          `marker with a reason.`
      );
      continue;
    }

    const isFrom = line.includes('.from("tasks")');
    const isEmbed = EMBED.test(line);
    if (!isFrom && !isEmbed) continue;

    const block = statementFrom(lines, i);
    if (isFrom) {
      // Skip writes; only reads are checked.
      const isRead = block.includes(".select(");
      const isWrite = /\.(insert|update|delete|upsert)\(/.test(block);
      if (!isRead || isWrite) continue;
    }

    if (block.includes("taskVisibilityFilter(")) continue;
    if (hasMarker(lines, i)) continue;

    found.push(
      `${relPath}:${i + 1} reads tasks without the visibility rule. Use ` +
        `visibleTasks() or findVisibleTask() from tools/filters.js, or add ` +
        `an allow marker with a reason.`
    );
  }

  return found;
}

describe("task visibility lint", () => {
  const files = tsFiles(TOOLS);

  it("finds tool sources to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const absPath of files) {
    const relPath = relative(SRC, absPath).split(sep).join("/");
    const source = readFileSync(absPath, "utf8");
    if (!source.includes("tasks")) continue;

    it(`${relPath}: tasks reads apply the visibility rule`, () => {
      expect(violations(relPath, source)).toEqual([]);
    });
  }

  it("flags a direct read that skips the rule", () => {
    const source = [
      "const { data } = await ctx.db",
      '  .from("tasks")',
      '  .select("*")',
      '  .eq("company_id", ctx.companyId);',
    ].join("\n");
    expect(violations("x.ts", source)).toHaveLength(1);
  });

  it("flags a direct liveTasks() call", () => {
    expect(violations("x.ts", 'const q = liveTasks(ctx.db, "id");')).toHaveLength(1);
  });

  it("flags an embedded tasks read that skips the rule", () => {
    expect(violations("x.ts", 'q.from("task_links").select("tasks(*)");')).toHaveLength(1);
  });

  it("accepts a read with an allow marker", () => {
    const source = [
      "// task-visibility-lint: allow - internal count",
      "const { count } = await ctx.db",
      '  .from("tasks")',
      '  .select("id", { count: "exact", head: true });',
    ].join("\n");
    expect(violations("x.ts", source)).toEqual([]);
  });

  it("flags a dynamic table read in restore.ts that skips visibleRows()", () => {
    const source = 'const { data } = await supabase.from(config.table).select("*").eq("id", id).single();';
    expect(violations("tools/restore.ts", source)).toHaveLength(1);
    expect(violations("tools/other.ts", source)).toEqual([]);
  });

  it("accepts a dynamic table read in restore.ts wrapped in visibleRows()", () => {
    const source = [
      "let q = visibleRows(",
      "  supabase",
      "    .from(RESTORE_CONFIG[type].table)",
      '    .select("*"),',
      "  type,",
      "  userId",
      ");",
    ].join("\n");
    expect(violations("tools/restore.ts", source)).toEqual([]);
  });

  it("ignores a dynamic table write in restore.ts", () => {
    const source = "await supabase.from(config.table).update(updates).eq(\"id\", id);";
    expect(violations("tools/restore.ts", source)).toEqual([]);
  });

  it("ignores writes", () => {
    const source = 'await ctx.db.from("tasks").update({ title: "x" }).eq("id", id).select().single();';
    expect(violations("x.ts", source)).toEqual([]);
  });
});
