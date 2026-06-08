#!/usr/bin/env node
/**
 * build.js - Injects build-time content into the setup page template.
 *
 * Injects two things from the repo:
 *   1. The current package version into the footer tag.
 *   2. The canonical supabase/setup.sql into the #setupSqlInlined data
 *      island, so the page can hand the user a database setup file with
 *      their chosen embedding dimension substituted in, with no network
 *      call. (The marketing-site copy of this page fetches the SQL from
 *      GitHub instead; this standalone copy inlines it.)
 *
 * Usage: node build.js [--out <path>]
 * Default output: ./dist/index.html
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'packages/mcp-server/package.json');
const SETUP_SQL_PATH = path.join(REPO_ROOT, 'supabase/setup.sql');
const TEMPLATE_PATH = path.join(__dirname, 'index.html');

// Parse args
let outPath = path.join(__dirname, 'dist', 'index.html');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = path.resolve(args[i + 1]);
    i++;
  }
}

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
const setupSql = fs.readFileSync(SETUP_SQL_PATH, 'utf-8');
const version = packageJson.version || '0.0.0';

if (setupSql.indexOf('</script>') !== -1) {
  // Would break out of the data island; setup.sql should never contain this.
  throw new Error('supabase/setup.sql contains "</script>" and cannot be inlined safely.');
}
if (!/vector\(1024\)/.test(setupSql)) {
  // The page substitutes vector(1024) -> vector(<dim>). If the literal is
  // gone, substitution would silently no-op and ship a wrong-dimension file.
  throw new Error('supabase/setup.sql no longer contains "vector(1024)"; update build.js / the page substitution.');
}

// Inject version into the footer tag, then inline setup.sql into the data
// island. Use a function replacement so "$" sequences in the SQL (e.g. the
// plpgsql "$$" bodies) are not interpreted as replacement patterns.
const output = template
  .replace(
    /<span id="versionTag">[^<]*<\/span>/,
    `<span id="versionTag">v${version}</span>`
  )
  .replace('__SETUP_SQL__', () => setupSql);

const outDir = path.dirname(outPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, output, 'utf-8');

console.log(`Built setup page: ${outPath}`);
console.log(`  Version: v${version}`);
console.log(`  Inlined setup.sql: ${setupSql.length} bytes`);
