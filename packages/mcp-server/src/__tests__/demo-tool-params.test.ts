// ============================================================
// Demo tool-param lint
// ============================================================
// Guards demo walkthroughs against drifting from the real tool
// schemas. For every `Tool:` / `Params:` block in a demo script,
// this test checks that each top-level parameter name actually
// exists on that tool's Zod schema.
//
// Catches the class of bugs where a demo uses e.g. `tags` instead
// of `tag`, `assignee` instead of `assigned_to`, or `confirm` on a
// tool that has no such parameter.
//
// The allowed-param set comes straight from each tool's
// `parameters.shape`. If a param is renamed in the schema, this
// test starts flagging demos that still use the old name.
// ============================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename } from "node:path";

import {
  taskTools,
  restoreTools,
  memoryTools,
  financialTools,
  financialManagementTools,
  projectTools,
  feedTools,
  itemTools,
  bookmarkTools,
  briefingTools,
  customerTools,
  contactTools,
  interactionTools,
  dashboardTools,
  playbookTools,
  governanceTools,
  triggerTools,
  tagTools,
  memberTools,
  surfaceTools,
} from "@ourthinktank/founders-os-core";

// Merge every domain ToolMap into one name -> definition lookup.
const allTools = {
  ...taskTools,
  ...restoreTools,
  ...memoryTools,
  ...financialTools,
  ...financialManagementTools,
  ...projectTools,
  ...feedTools,
  ...itemTools,
  ...bookmarkTools,
  ...briefingTools,
  ...customerTools,
  ...contactTools,
  ...interactionTools,
  ...dashboardTools,
  ...playbookTools,
  ...governanceTools,
  ...triggerTools,
  ...tagTools,
  ...memberTools,
  ...surfaceTools,
} as Record<string, { parameters?: { shape?: Record<string, unknown>; _def?: { schema?: { shape?: Record<string, unknown> } } } }>;

// tool name -> Set of allowed top-level param names (from the zod shape).
const toolParams = new Map<string, Set<string>>();
for (const [name, def] of Object.entries(allTools)) {
  const schema = def?.parameters;
  // In zod 4, `.refine()` no longer wraps an object in ZodEffects (checks
  // live on the schema), so a tool's parameters object exposes `.shape`
  // directly. Tool parameters are always a ZodObject.
  const shape = schema?.shape ?? {};
  toolParams.set(name, new Set(Object.keys(shape)));
}

const demosDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../demos");

// --- helpers --------------------------------------------------

/** Read the balanced `{ ... }` object beginning at/after a `Params:` marker. */
function readObject(lines: string[], startLine: number, afterParams: string): string | null {
  let combined = afterParams;
  let li = startLine;
  while (!combined.includes("{") && li + 1 < lines.length) {
    li++;
    combined += "\n" + lines[li];
  }
  const start = combined.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inStr: string | null = null;
  let i = start;
  while (true) {
    while (i < combined.length) {
      const c = combined[i];
      if (inStr) {
        if (c === "\\") { i += 2; continue; }
        if (c === inStr) inStr = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return combined.slice(start, i + 1);
      }
      i++;
    }
    if (li + 1 >= lines.length) return null; // unbalanced
    li++;
    combined += "\n" + lines[li];
  }
}

/** Extract the top-level keys of an object-literal string (string-aware, depth-aware). */
function topLevelKeys(obj: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let expectKey = false; // true immediately after `{` or `,` at depth 1
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      if (c === "{" && depth === 1) expectKey = true;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth === 1 && c === ",") { expectKey = true; continue; }
    if (depth === 1 && expectKey && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < obj.length && /[A-Za-z0-9_]/.test(obj[j])) j++;
      const ident = obj.slice(i, j);
      let k = j;
      while (k < obj.length && /\s/.test(obj[k])) k++;
      if (obj[k] === ":") keys.push(ident);
      expectKey = false;
      i = j - 1;
      continue;
    }
    if (depth === 1 && !/\s/.test(c)) expectKey = false;
  }
  return keys;
}

interface Violation {
  file: string;
  line: number;
  tool: string;
  param: string;
  allowed: string[];
}

function lintFile(path: string): { violations: Violation[]; unknownTools: Set<string> } {
  const file = basename(path);
  const lines = readFileSync(path, "utf8").split("\n");
  const violations: Violation[] = [];
  const unknownTools = new Set<string>();

  let currentTool: string | null = null;
  let currentToolLine = 0;

  for (let idx = 0; idx < lines.length; idx++) {
    const tm = lines[idx].match(/^Tool:\s*([A-Za-z_][A-Za-z0-9_]*)/);
    if (tm) {
      currentTool = tm[1];
      currentToolLine = idx + 1;
      continue;
    }
    const pPos = lines[idx].indexOf("Params:");
    if (pPos !== -1 && currentTool) {
      const objStr = readObject(lines, idx, lines[idx].slice(pPos + "Params:".length));
      if (objStr) {
        const allowed = toolParams.get(currentTool);
        if (!allowed) {
          // Not a founders-os domain tool we introspect (e.g. meta/diagnostic
          // tools referenced in prose). Skip param validation, surface for info.
          unknownTools.add(currentTool);
        } else {
          for (const key of topLevelKeys(objStr)) {
            if (!allowed.has(key)) {
              violations.push({
                file,
                line: currentToolLine,
                tool: currentTool,
                param: key,
                allowed: [...allowed].sort(),
              });
            }
          }
        }
      }
      currentTool = null;
    }
  }
  return { violations, unknownTools };
}

// --- tests ----------------------------------------------------

describe("demo tool-call parameters match the real tool schemas", () => {
  const files = readdirSync(demosDir).filter((f) => f.endsWith("-walkthrough.md"));

  it("finds demo walkthroughs to lint", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("self-check: the parser extracts top-level keys correctly", () => {
    const keys = topLevelKeys('{ task_id: <x>, assignee: "@y", links: [{ entity_type: "customer" }] }');
    expect(keys).toEqual(["task_id", "assignee", "links"]);
  });

  it("every Params key exists on the tool's zod schema", () => {
    const allViolations: Violation[] = [];
    for (const f of files) {
      allViolations.push(...lintFile(join(demosDir, f)).violations);
    }
    const report = allViolations
      .map(
        (v) =>
          `  ${v.file}:${v.line}  ${v.tool} -> unknown param "${v.param}"\n      allowed: ${v.allowed.join(", ")}`,
      )
      .join("\n");
    expect(allViolations, `Demo tool-call params not found on the tool schema:\n${report}`).toHaveLength(0);
  });
});
