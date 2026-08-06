#!/usr/bin/env bash
# ============================================================
# Founders OS - MCPB bundle builder
# ============================================================
# Produces build/founders-os-<version>.mcpb, a self-contained
# bundle for Claude Desktop one-click install and for Smithery
# local publishing.
#
#   ./packaging/mcpb/build.sh 1.7.0
#
# The bundle is built from the PUBLISHED npm package, never from
# this workspace. Installing @ourthinktank/founders-os@<version>
# into a clean directory makes npm resolve the core dependency
# from the registry at the exact version the release pinned,
# which is precisely what a self-hoster gets. Building from the
# monorepo would drag in workspace symlinks and dev dependencies
# and would not exercise the same resolution path.
#
# VERSION DISCIPLINE (runbook P7): per RELEASING.md the version
# fields in this repo lag deliberately and the release tag is
# authoritative. So the version comes from the argument, is used
# to install an exact package, and is then ASSERTED against what
# npm actually installed. The repo working tree is never read for
# a version. Do not "simplify" this by reading package.json.
# ============================================================
set -euo pipefail

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: $0 <npm-version>    e.g. $0 1.7.0" >&2
  echo "       the version must already be published to npm" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/packaging/mcpb"
OUT="$REPO_ROOT/build/mcpb"
ARTIFACT="$REPO_ROOT/build/founders-os-$VERSION.mcpb"
PKG="@ourthinktank/founders-os"

echo "==> Building MCPB bundle for $PKG@$VERSION"

# ── 1. Clean staging directory ──────────────────────────────
rm -rf "$OUT"
mkdir -p "$OUT/server"

# ── 2. Install the published package, production deps only ──
cd "$OUT"
npm init -y >/dev/null
npm pkg set type=module name=founders-os-mcpb version="$VERSION" >/dev/null
npm install "$PKG@$VERSION" --omit=dev --no-audit --no-fund

# ── 3. Assert we got the version we asked for ───────────────
# Guards against an npm alias, a stale cache, or a dist-tag surprise
# silently producing a bundle that claims one version and runs another.
INSTALLED="$(node -p "require('./node_modules/$PKG/package.json').version")"
if [ "$INSTALLED" != "$VERSION" ]; then
  echo "ERROR: asked for $VERSION but npm installed $INSTALLED" >&2
  exit 1
fi
echo "==> Verified installed version: $INSTALLED"

# ── 4. Copy shim, icons, ignore file ────────────────────────
# icon.png sits at the bundle root because the manifest "icon" field is a
# bare filename; the per-size PNGs are referenced as assets/icon-<size>.png.
cp "$SRC/server/index.js" "$OUT/server/index.js"
cp "$SRC/assets/icon.png" "$OUT/icon.png"
cp -R "$SRC/assets" "$OUT/assets"
cp "$SRC/.mcpbignore" "$OUT/.mcpbignore"

# ── 5. Render the manifest ──────────────────────────────────
# Only ${VERSION} is substituted. The MCPB runtime placeholders
# (${__dirname}, ${user_config.*}) must survive into the output
# untouched, which is why this is a targeted replace and not envsubst.
node -e '
  const fs = require("fs");
  const [tplPath, version, outPath] = process.argv.slice(1);
  const rendered = fs
    .readFileSync(tplPath, "utf8")
    .replace(/\$\{VERSION\}/g, version);
  const parsed = JSON.parse(rendered); // fail loudly on malformed output
  if (parsed.version !== version) {
    throw new Error(`manifest version ${parsed.version} != ${version}`);
  }
  if ("tools" in parsed) {
    // smithery-ai/cli#787: `smithery mcp publish` rejects any bundle whose
    // manifest declares tools, because it forwards them to the registry as
    // MCP Tool[] (which require inputSchema) while the MCPB schema forbids
    // inputSchema on tool entries. No manifest satisfies both. We omit tools
    // and set tools_generated instead. Re-check that issue before adding
    // a tools array back.
    throw new Error("manifest declares tools; Smithery publish will reject it");
  }
  fs.writeFileSync(outPath, rendered);
' "$SRC/manifest.template.json" "$VERSION" "$OUT/manifest.json"

# ── 6. Validate and pack ────────────────────────────────────
cd "$REPO_ROOT"
mkdir -p "$REPO_ROOT/build"
npx --yes @anthropic-ai/mcpb validate "$OUT/manifest.json"
npx --yes @anthropic-ai/mcpb pack "$OUT" "$ARTIFACT"

# ── 7. Report ───────────────────────────────────────────────
# Bundles ship UNSIGNED (runbook P8). Claude Desktop logs "Installing
# unsigned extension" and proceeds; a self-signed certificate produces
# its own warning, so signing ourselves buys nothing.
npx --yes @anthropic-ai/mcpb info "$ARTIFACT"
echo
echo "==> Built $ARTIFACT"
echo "    size: $(du -h "$ARTIFACT" | cut -f1)"
echo
echo "Next: run the verification checklist in"
echo "  founders-os-docs/distribution/mcpb-bundle-smithery-runbook.md section 8"
echo "then publish:"
echo "  smithery mcp publish $ARTIFACT -n ourthinktank/founders-os"
