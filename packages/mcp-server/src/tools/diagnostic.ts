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

async function fetchLatestVersion(): Promise<string | null> {
  return (
    (await checkRegistry(
      "https://npm.pkg.github.com/@ourthinktank/founders-os/latest",
      AbortSignal.timeout(5000)
    ).catch(() => null)) ??
    (await checkRegistry(
      "https://registry.npmjs.org/@ourthinktank/founders-os/latest",
      AbortSignal.timeout(5000)
    ).catch(() => null))
  );
}

type LaunchMethod = "npx" | "global" | "local" | "unknown";

// Classify how this process was launched, from the module path plus npm's
// own env vars. NOTE: the literal version spec from the MCP config
// (`@latest` vs `@1.2.0`) is consumed by npx before launch and is NOT
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

function upgradeGuidance(method: LaunchMethod): string {
  switch (method) {
    case "npx":
      return "Launched via npx. To pick up a new version: make sure your MCP config pins @latest (e.g. \"npx -y @ourthinktank/founders-os@latest\"), then fully restart your AI app so npx re-resolves. If a stale version persists, clear the npx cache (npm cache clean --force, or remove the _npx cache dir).";
    case "global":
      return "Running from a global install. Upgrade with: npm install -g @ourthinktank/founders-os@latest, then restart your AI app.";
    case "local":
      return "Running from a local project dependency. Bump @ourthinktank/founders-os in that project's package.json (or npm install @ourthinktank/founders-os@latest), reinstall, then restart your AI app.";
    default:
      return "Could not determine how the connector was launched. Update however you installed it (npx config @latest, global npm, or local dependency), then restart your AI app. See installPath below.";
  }
}

/**
 * Compare the database's schema_version marker (founders_os_meta)
 * against what this server version expects, and produce the fields
 * get_version reports. Never throws: a database problem becomes a
 * status string, not a tool failure.
 */
async function checkDbSchema(
  db: ToolContext["db"]
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
  };
  try {
    const { data, error } = await db
      .from("founders_os_meta")
      .select("value")
      .eq("key", "schema_version")
      .maybeSingle();

    if (error) {
      // 42P01 = undefined_table (raw Postgres), PGRST205 = table not found
      // in PostgREST's schema cache. Either way: the marker predates this
      // database, which is expected for installs created before the marker.
      if (error.code === "42P01" || error.code === "PGRST205") {
        out.dbSchemaVersion = null;
        out.dbSchemaStatus = "untracked";
        out.howToUpdateDb =
          "This database predates schema-version tracking. Run the SCHEMA VERSION MARKER section of supabase/setup.sql in your Supabase SQL Editor (it is idempotent and safe on an existing database), then any migration files in supabase/migrations/ you have not applied yet.";
      } else {
        out.dbSchemaVersion = null;
        out.dbSchemaStatus = "unknown";
        out.dbSchemaError = error.message;
      }
      return out;
    }

    const dbVersion = data ? Number.parseInt(data.value, 10) : NaN;
    if (!data || !Number.isFinite(dbVersion)) {
      out.dbSchemaVersion = null;
      out.dbSchemaStatus = "untracked";
      out.howToUpdateDb =
        "The founders_os_meta table exists but carries no schema_version marker. Run the SCHEMA VERSION MARKER section of supabase/setup.sql (idempotent) to set it.";
      return out;
    }

    out.dbSchemaVersion = dbVersion;
    if (dbVersion === EXPECTED_SCHEMA_VERSION) {
      out.dbSchemaStatus = "current";
    } else if (dbVersion < EXPECTED_SCHEMA_VERSION) {
      out.dbSchemaStatus = "behind";
      out.howToUpdateDb =
        `Your database is at schema version ${dbVersion} but this server expects ${EXPECTED_SCHEMA_VERSION}. ` +
        `In your Supabase SQL Editor, run the files in supabase/migrations/ numbered ${String(dbVersion + 1).padStart(3, "0")} through ${String(EXPECTED_SCHEMA_VERSION).padStart(3, "0")}, in order. ` +
        `Migrations are idempotent; re-running one you already applied is safe.`;
    } else {
      out.dbSchemaStatus = "ahead";
      out.howToUpdateDb =
        `Your database is at schema version ${dbVersion}, newer than this server expects (${EXPECTED_SCHEMA_VERSION}). ` +
        `Update the connector itself (see howToUpdate); do not change the database.`;
    }
  } catch (err) {
    out.dbSchemaVersion = null;
    out.dbSchemaStatus = "unknown";
    out.dbSchemaError = err instanceof Error ? err.message : "Schema check failed";
  }
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
        "Returns the running version of @ourthinktank/founders-os, the rendering contract version (used to detect plugin/server drift), how the connector was launched (launchMethod: npx | global | local | unknown) with a tailored howToUpdate string, optionally the latest published version from the npm registry, and the database schema status (dbSchemaStatus: current | behind | ahead | untracked | unknown) with a howToUpdateDb step when action is needed. Call at session start; if updateAvailable is true relay current vs latest and the howToUpdate step, and if dbSchemaStatus is behind or untracked relay the howToUpdateDb step.",
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

      const result: Record<string, unknown> = {
        package: "@ourthinktank/founders-os",
        current: currentVersion,
        contract_version: RENDERING_CONTRACT_VERSION,
        launchMethod,
        installPath: __filename,
        howToUpdate: upgradeGuidance(launchMethod),
      };

      if (check_latest !== false) {
        try {
          const latest = await fetchLatestVersion();
          if (latest) {
            result.latest = latest;
            result.updateAvailable = latest !== currentVersion;
          } else {
            result.latest = null;
            result.registryError = "Could not reach GitHub Packages or npm registry";
          }
        } catch (err) {
          result.latest = null;
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
