#!/usr/bin/env node
/* ============================================================
 * sync-setup-generators - copy the canonical generators to the mkt-site
 * ============================================================
 * The setup wizard exists on two pages in two repos that historically
 * drifted: this repo's standalone page (integrations/setup-page/index.html)
 * and the marketing site (founders-os-mkt-site/src/pages/setup.astro). The
 * generation logic now lives in ONE canonical file here
 * (lib/setup-generators.js); this script copies it into the mkt-site repo so
 * that page imports the same code instead of a hand-maintained duplicate.
 *
 * Run it from the mkt-site build (or by hand) whenever the canonical module
 * changes. The destination is written with a generated banner and must never
 * be hand-edited - edit lib/setup-generators.js here and re-sync.
 *
 * Usage:
 *   node tools/sync-setup-generators.mjs [--target <path>]
 * Default target: ../../founders-os-mkt-site/src/lib/setup-generators.js
 * (sibling checkout). The script refuses to create the target repo dir; if
 * it is missing it tells you rather than scattering files.
 * ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "lib", "setup-generators.js");
const REPO_ROOT = path.resolve(__dirname, "..", "..", ".."); // founders-os/

// Default: sibling founders-os-mkt-site checkout.
let target = path.resolve(REPO_ROOT, "..", "founders-os-mkt-site", "src", "lib", "setup-generators.js");
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--target" && args[i + 1]) target = path.resolve(args[++i]);
}

const BANNER =
  "/* AUTO-GENERATED — do not edit. Synced from founders-os\n" +
  " * integrations/setup-page/lib/setup-generators.js by tools/sync-setup-generators.mjs.\n" +
  " * Edit the canonical file there and re-run the sync. */\n";

const src = fs.readFileSync(SRC, "utf-8");

const targetDir = path.dirname(target);
// Refuse to scaffold a missing repo - the mkt-site checkout must exist.
const repoMarker = path.resolve(targetDir, "..", ".."); // .../founders-os-mkt-site
if (!fs.existsSync(repoMarker)) {
  console.error(
    `[sync] target repo not found at ${repoMarker}.\n` +
    `       Check out founders-os-mkt-site as a sibling, or pass --target <path>.`
  );
  process.exit(1);
}
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(target, BANNER + src, "utf-8");
console.log(`[sync] wrote ${src.length} bytes -> ${target}`);
