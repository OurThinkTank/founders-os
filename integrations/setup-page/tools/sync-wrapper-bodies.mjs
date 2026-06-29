#!/usr/bin/env node
/* ============================================================
 * sync-wrapper-bodies - inject the real tick-wrapper text into the module
 * ============================================================
 * The setup wizard offers the tick wrapper as a direct download, so the
 * generators module (lib/setup-generators.js) carries a copy of each wrapper
 * body. integrations/scheduler/foundersos-tick.{sh,cmd} stay the canonical
 * source; this script copies their exact bytes into the WRAPPER_SH /
 * WRAPPER_CMD literals as JSON-escaped strings (valid JS string literals, so
 * `${...}` and backticks in the bash are not interpreted).
 *
 * Re-run it whenever a wrapper file changes. It is idempotent and exits
 * non-zero if it cannot find the literals to replace. setup-generators.test.mjs
 * independently asserts the module's copies match the files, so a forgotten
 * re-run is caught in tests, not in production.
 *
 *   node tools/sync-wrapper-bodies.mjs
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, "..", "lib", "setup-generators.js");
const SCHED = path.resolve(__dirname, "..", "..", "scheduler");

const sh = fs.readFileSync(path.join(SCHED, "foundersos-tick.sh"), "utf-8");
const cmd = fs.readFileSync(path.join(SCHED, "foundersos-tick.cmd"), "utf-8");

let src = fs.readFileSync(MODULE, "utf-8");

function replaceLiteral(text, name, value) {
  // Match `var NAME = "...";` on a single line (JSON.stringify is one line).
  const re = new RegExp('var ' + name + ' = "(?:[^"\\\\]|\\\\.)*";');
  if (!re.test(text)) {
    console.error(`[sync-wrapper-bodies] could not find literal ${name} in module`);
    process.exit(1);
  }
  return text.replace(re, 'var ' + name + ' = ' + JSON.stringify(value) + ';');
}

src = replaceLiteral(src, "WRAPPER_SH", sh);
src = replaceLiteral(src, "WRAPPER_CMD", cmd);
fs.writeFileSync(MODULE, src, "utf-8");
console.log(`[sync-wrapper-bodies] injected ${sh.length}B sh + ${cmd.length}B cmd into ${path.basename(MODULE)}`);
