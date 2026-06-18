# Releasing FoundersOS

How FoundersOS is built, tested as a package, and published to npm. This repo ships two packages that publish together:

- `@ourthinktank/founders-os-core` - the transport-agnostic core (`packages/core`)
- `@ourthinktank/founders-os` - the MCP server (`packages/mcp-server`), which depends on core

Ground rules that apply to every path below:

- The two packages share one version and move in lockstep.
- Core must be published before mcp-server, because mcp-server depends on it.
- In the repo, mcp-server declares the core dependency as `"*"`; at publish time it is pinned to the exact version so consumers resolve a concrete release.
- The version fields in the `package.json` files are not the source of truth. The release tag (or the workflow input) is, and CI overwrites the version fields at publish time. They may lag in the repo, which is fine.
- Publishing uses npm provenance, which works because the repo is public.
- `main` is the public release line; `develop` is the integration line. Releases come from `main`, prereleases from `develop`.

## 1. Standard release (publishes to `latest`)

Driven by `.github/workflows/publish.yml`, which fires when a GitHub release is published.

1. Land everything for the release on `develop` and confirm it is green (`npm test` from the root runs both packages).
2. Open a PR `develop` -> `main` and merge once reviewed.
3. On `main`, create a GitHub release with a tag of the form `vX.Y.Z` (the leading `v` is stripped by CI).
4. CI then, in order: syncs all package versions from the tag, runs `npm ci`, builds, publishes core with `--provenance`, pins mcp-server's core dependency to the exact version, publishes mcp-server with `--provenance`, and builds the standalone setup page and attaches it to the release as an asset.

You do not bump versions by hand for a release; the tag is authoritative. Requires the `NPM_TOKEN` repository secret.

## 2. Local test build (no registry) - `npm pack`

Use this to test the exact packaged artifact (the `files`/`bin`/`exports` boundary, not just the source) without publishing anything. Good for a quick pre-release smoke test or verifying packaging changes.

```bash
git checkout develop && git pull && npm ci
npm run build
npm test                       # gate: both packages green

# Pack core, then test the pair from a scratch consumer so the core dep resolves
npm pack -w packages/core      # -> ourthinktank-founders-os-core-<version>.tgz

mkdir -p /tmp/fos-pack-test && cd /tmp/fos-pack-test && npm init -y
npm install /path/to/ourthinktank-founders-os-core-<version>.tgz
```

Then pack mcp-server with its core dependency pinned to the packed version and install the resulting tarball:

```bash
cd /path/to/founders-os
npm -w packages/mcp-server pkg set "dependencies.@ourthinktank/founders-os-core=<version>"
npm pack -w packages/mcp-server   # -> ourthinktank-founders-os-<version>.tgz
# (revert the pkg set afterwards: it should stay "*" in the repo)

cd /tmp/fos-pack-test
npm install /path/to/ourthinktank-founders-os-<version>.tgz
npx founders-os                   # or point an MCP client at ./node_modules/.bin/founders-os
```

Verify the running server with `get_version` in your client. For a faster loop that skips the packaging boundary, just point a client at `packages/mcp-server/dist/index.js` after `npm run build` (see the README "Local install for testing").

## 3. Prerelease channel (registry) - the `next` dist-tag

Use this to put a real, installable build on npm for remote testers without moving `latest`. Driven by `.github/workflows/prerelease.yml` (manual, `workflow_dispatch`).

1. Run the "Publish prerelease to npm" workflow from the Actions tab.
2. Inputs: a prerelease `version` such as `0.15.0-rc.1` (it must contain a hyphen), the `ref` to build from (defaults to `develop`), and the `dist_tag` (defaults to `next`).
3. The workflow validates the inputs (rejects a non-prerelease version and refuses `latest`), syncs versions, builds, tests, then publishes core and mcp-server under the chosen dist-tag with provenance.

Testers install with:

```bash
npx -y @ourthinktank/founders-os@next
```

Two footguns this flow is built to avoid:

- `npm publish` applies the `latest` dist-tag even to a prerelease version unless you pass `--tag`. The workflow always passes `--tag` and refuses `latest`, so a prerelease can never become `latest`.
- A prerelease version (with a hyphen) is not surfaced to plain `npm install` / `@latest` users, so it stays opt-in.

When a prerelease is good, ship the final version through the standard release flow in section 1; the `next` tag can be left to expire or be re-pointed by the next prerelease. Do not promote a prerelease build to `latest` by hand.

## Manual fallback

If CI is unavailable, the prerelease can be run by hand from a clean `develop` checkout, mirroring the workflow steps: set the version on root + both packages, `npm ci`, `npm run build`, `npm test`, `npm publish -w packages/core --tag next --provenance`, pin mcp-server's core dep to the exact version, then `npm publish -w packages/mcp-server --tag next --provenance`. Requires an npm token with publish rights to the `@ourthinktank` scope.
