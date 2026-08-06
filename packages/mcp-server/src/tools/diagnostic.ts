// ============================================================
// Founders OS — Diagnostic Tools
// ============================================================
// ping          — basic connectivity test; embeds update notice if stale
// get_version   — returns current version + optional registry check
//
// These tools are registered directly (not via registerToolMap)
// because their handlers return MCP content envelopes directly
// rather than plain data objects, and they have unique startup
// dependencies (versionNotice, registry fetch).
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  RENDERING_CONTRACT_VERSION,
  EXPECTED_SCHEMA_VERSION,
  getSchemaState,
} from "@ourthinktank/founders-os-core";
import type { ToolContext } from "@ourthinktank/founders-os-core";

async function checkRegistry(
  url: string,
  signal: AbortSignal
): Promise<string | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const { version } = (await res.json()) as { version: string };
  return version;
}

// Fetch the version a dist-tag currently points to (e.g. "latest" or "next").
// GitHub Packages first, npm registry as fallback; both support the
// GET /{pkg}/{tag} manifest endpoint.
async function fetchDistTag(tag: string): Promise<string | null> {
  const enc = encodeURIComponent(tag);
  return (
    (await checkRegistry(
      `https://npm.pkg.github.com/@ourthinktank/founders-os/${enc}`,
      AbortSignal.timeout(5000)
    ).catch(() => null)) ??
    (await checkRegistry(
      `https://registry.npmjs.org/@ourthinktank/founders-os/${enc}`,
      AbortSignal.timeout(5000)
    ).catch(() => null))
  );
}

// ── semver precedence (no external dependency) ──────────────────────────────
// Compares version strings per semver.org §11: build metadata (+...) is
// ignored; a prerelease has LOWER precedence than its associated normal
// version; prerelease identifiers are compared left-to-right, numeric ones
// numerically, numeric ranks below alphanumeric, and a longer identifier list
// wins when all earlier identifiers are equal. This replaces the old
// `latest !== current` string check, which wrongly flagged a prerelease that
// is *ahead* of the stable `latest` tag as an available "update".
type ParsedSemver = { nums: [number, number, number]; pre: string[] };

export function parseSemver(v: string): ParsedSemver | null {
  const noBuild = v.trim().replace(/^v/, "").split("+")[0];
  const dash = noBuild.indexOf("-");
  const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preRaw = dash === -1 ? "" : noBuild.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number.parseInt(p, 10) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return {
    nums: nums as [number, number, number],
    pre: preRaw ? preRaw.split(".") : [],
  };
}

// -1 if a < b, 0 if equal, 1 if a > b, null if either side is not parseable.
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // Equal core: a normal version outranks a prerelease of the same core.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number.parseInt(x, 10) < Number.parseInt(y, 10) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1; // numeric identifiers rank below alphanumeric
    return x < y ? -1 : 1;
  }
  if (pa.pre.length === pb.pre.length) return 0;
  return pa.pre.length < pb.pre.length ? -1 : 1;
}

export function isPrerelease(v: string): boolean {
  const p = parseSemver(v);
  return p ? p.pre.length > 0 : false;
}

type LaunchMethod = "npx" | "global" | "local" | "unknown";

// Classify how this process was launched, from the module path plus npm's
// own env vars. NOTE: the literal version spec from the MCP config
// (`@latest` vs `@0.14.1`) is consumed by npx before launch and is NOT
// observable here, so we report the launch *method*, which is enough to
// give the user the correct upgrade step.
function detectLaunchMethod(modulePath: string): LaunchMethod {
  const p = modulePath.replace(/\\/g, "/");
  const ua = process.env.npm_config_user_agent ?? "";
  const lifecycle = process.env.npm_lifecycle_event ?? "";
  const command = process.env.npm_command ?? "";

  if (p.includes("/_npx/") || lifecycle === "npx" || command === "exec") {
    return "npx";
  }
  // Global install: under a node prefix's node_modules (e.g. /usr/lib/node_modules,
  // /usr/local/lib/node_modules, ~/.nvm/.../lib/node_modules) or npm_config_global set.
  if (
    process.env.npm_config_global === "true" ||
    /\/lib\/node_modules\//.test(p) ||
    /\/npm\/node_modules\//.test(p)
  ) {
    return "global";
  }
  // Local project dependency.
  if (p.includes("/node_modules/")) return "local";
  // Fall back: npx user-agent without a recognizable path still implies npx.
  if (/\bnpx\b/.test(ua)) return "npx";
  return "unknown";
}

// `tag` is the dist-tag for this version's channel ("latest" for stable,
// "next" for a prerelease) so the guidance points the user at the right
// channel instead of hardcoding @latest.
function upgradeGuidance(method: LaunchMethod, tag: string): string {
  const spec = `@ourthinktank/founders-os@${tag}`;
  switch (method) {
    case "npx":
      return `Launched via npx. To pick up a new version: make sure your MCP config pins @${tag} (e.g. "npx -y ${spec}"), then fully restart your AI app so npx re-resolves. If a stale version persists, clear the npx cache (npm cache clean --force, or remove the _npx cache dir).`;
    case "global":
      return `Running from a global install. Upgrade with: npm install -g ${spec}, then restart your AI app.`;
    case "local":
      return `Running from a local project dependency. Bump @ourthinktank/founders-os in that project's package.json (or npm install ${spec}), reinstall, then restart your AI app.`;
    default:
      return `Could not determine how the connector was launched. Update however you installed it (npx config @${tag}, global npm, or local dependency), then restart your AI app. See installPath below.`;
  }
}

/**
 * Compare the database's schema_version marker (founders_os_meta)
 * against what this server version expects, and produce the fields
 * get_version reports. Never throws: a database problem becomes a
 * status string, not a tool failure.
 *
 * The classification itself lives in core (schema-state.ts) because
 * registerToolMap needs the same answer when a tool call fails against an
 * unprovisioned database. This function is now a thin projection of that
 * shared state onto the field names get_version has always reported, so the
 * two paths cannot drift apart.
 *
 * One behaviour change from the previous inline version: a database where
 * founders_os_meta is absent now reports "missing" when the schema was never
 * installed at all, and keeps reporting "untracked" only for a real legacy
 * install that predates the marker. Those two need opposite advice and used
 * to be conflated.
 */
async function checkDbSchema(
  db: ToolContext["db"]
): Promise<Record<string, unknown>> {
  const state = await getSchemaState(db);

  const out: Record<string, unknown> = {
    expectedSchemaVersion: state.expectedVersion,
    dbSchemaVersion: state.dbVersion,
    dbSchemaStatus: state.status,
  };
  if (state.guidance) out.howToUpdateDb = state.guidance;
  if (state.error) out.dbSchemaError = state.error;
  return out;
}

export function registerDiagnosticTools(
  server: McpServer,
  { versionNotice, db }: { versionNotice: string; db: ToolContext["db"] }
): void {
  // ── ping ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: `Test tool — returns pong.${versionNotice}`,
      inputSchema: {
        message: z.string().optional().describe("Optional message to echo back"),
      },
    },
    async ({ message }: { message?: string }) => ({
      content: [
        {
          type: "text" as const,
          text: message ? `pong: ${message}` : "pong",
        },
      ],
    })
  );

  // ── get_version ───────────────────────────────────────────────────────────

  server.registerTool(
    "get_version",
    {
      title: "Get Version",
      description:
        "Returns the running version of @ourthinktank/founders-os, the rendering contract version (used to detect plugin/server drift), how the connector was launched (launchMethod: npx | global | local | unknown) with a tailored howToUpdate string, the release channel (channel: stable | prerelease), the published head of that channel, and the database schema status (dbSchemaStatus: current | behind | ahead | untracked | unknown) with a howToUpdateDb step when action is needed. Version comparison is semver-aware and channel-aware: stable builds compare against the `latest` tag, prerelease builds against the `next` tag, so a prerelease that is ahead of stable is NOT reported as an update. versionStatus is one of current | update-available | ahead | unknown; updateAvailable is true only when a genuinely newer version exists on your channel (with updateTo naming it). Call at session start; if updateAvailable is true relay current vs updateTo and the howToUpdate step, and if dbSchemaStatus is behind or untracked relay the howToUpdateDb step.",
      inputSchema: {
        check_latest: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true, also query the registry for the latest version (default: true)"),
      },
    },
    async ({ check_latest }: { check_latest?: boolean }) => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const pkgPath = resolve(__dirname, "..", "..", "package.json");
      const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
      const currentVersion: string = pkg.version;

      const launchMethod = detectLaunchMethod(__filename);
      const onPrerelease = isPrerelease(currentVersion);
      const channelTag = onPrerelease ? "next" : "latest";

      const result: Record<string, unknown> = {
        package: "@ourthinktank/founders-os",
        current: currentVersion,
        contract_version: RENDERING_CONTRACT_VERSION,
        channel: onPrerelease ? "prerelease" : "stable",
        launchMethod,
        installPath: __filename,
        howToUpdate: upgradeGuidance(launchMethod, channelTag),
      };

      if (check_latest !== false) {
        try {
          // Always report the stable head. On a prerelease, also fetch the
          // prerelease head ("next") and compare against THAT channel - a
          // prerelease is not "behind" the older stable `latest`.
          const stable = await fetchDistTag("latest");
          const prerelease = onPrerelease ? await fetchDistTag("next") : null;

          result.latest = stable;
          if (onPrerelease) result.prerelease = prerelease;

          const channelHead = onPrerelease ? prerelease : stable;

          if (!channelHead) {
            result.versionStatus = "unknown";
            result.updateAvailable = false;
            result.registryError =
              "Could not reach GitHub Packages or npm registry";
          } else {
            const cmp = compareSemver(channelHead, currentVersion);
            if (cmp === null) {
              result.versionStatus = "unknown";
              result.updateAvailable = false;
            } else if (cmp > 0) {
              result.versionStatus = "update-available";
              result.updateAvailable = true;
              result.updateTo = channelHead;
            } else if (cmp < 0) {
              // Running newer than the published channel head (a local build,
              // or a just-published version the registry has not surfaced yet).
              result.versionStatus = "ahead";
              result.updateAvailable = false;
            } else {
              result.versionStatus = "current";
              result.updateAvailable = false;
            }
          }

          // For a prerelease, note how it sits relative to the latest stable
          // so the reader understands the whole picture (e.g. ahead of stable).
          if (onPrerelease && stable) {
            const vsStable = compareSemver(currentVersion, stable);
            if (vsStable !== null) result.aheadOfStable = vsStable > 0;
          }
        } catch (err) {
          result.latest = null;
          result.versionStatus = "unknown";
          result.updateAvailable = false;
          result.registryError =
            err instanceof Error ? err.message : "Registry fetch failed";
        }
      }

      Object.assign(result, await checkDbSchema(db));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
