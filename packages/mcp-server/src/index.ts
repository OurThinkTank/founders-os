#!/usr/bin/env node

// ============================================================
// Founders OS — MCP Server (stdio)
// ============================================================
// Entry point for the @founders-os/mcp npm package. AI tools
// like Claude Desktop and Claude Code launch this as a
// subprocess and communicate over stdin/stdout using the MCP
// protocol.
//
// Usage (Claude Desktop claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "founders-os": {
//         "command": "npx",
//         "args": ["-y", "@founders-os/mcp"],
//         "env": {
//           "SUPABASE_URL": "https://your-project.supabase.co",
//           "SUPABASE_SECRET_KEY": "sb_secret_..."
//         }
//       }
//     }
//   }
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  RENDERING_CONTRACT,
  buildContext,
  registerCRMTools,
  registerMemoryTools,
  registerFinancialTools,
  registerFinancialManagementTools,
  registerMemberTools,
  registerRSSTools,
  registerTaskTools,
  registerTagTools,
  registerSurfaceTools,
  registerPlaybookTools,
  registerGovernanceTools,
  registerTriggerTools,
  registerProjectTools,
  registerRestoreTools,
} from "@ourthinktank/founders-os-core";
import { registerDiagnosticTools } from "./tools/diagnostic.js";
import { registerMetaTools } from "./tools/meta.js";

// ── Read version from package.json (never hardcode in two places) ──────────
const __boot_filename = fileURLToPath(import.meta.url);
const __boot_dirname = dirname(__boot_filename);
const __boot_pkg = JSON.parse(
  await readFile(resolve(__boot_dirname, "..", "package.json"), "utf-8")
);

// ── Startup version check ──────────────────────────────────────────────────
// Fire a quick registry lookup before registering tools. If the running
// version is behind, we embed a notice in the ping tool's description so
// any connected AI (or user browsing tools) sees it organically.
// Uses a 3-second timeout so a slow/unreachable registry never delays startup.
let versionNotice = "";

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const SEMVER_RE = /^\d+\.\d+\.\d+$/;

  const tryRegistry = async (url: string): Promise<string | null> => {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const ver = body["version"];
    // Validate the version string is safe semver before embedding in tool description
    if (typeof ver !== "string" || !SEMVER_RE.test(ver)) return null;
    return ver;
  };

  const latest =
    (await tryRegistry(
      "https://npm.pkg.github.com/@ourthinktank/founders-os/latest"
    ).catch(() => null)) ??
    (await tryRegistry(
      "https://registry.npmjs.org/@ourthinktank/founders-os/latest"
    ).catch(() => null));

  clearTimeout(timeout);

  if (latest && latest !== __boot_pkg.version) {
    versionNotice =
      ` Update available: running v${__boot_pkg.version}, latest v${latest}.` +
      ` Restart with @latest to update.`;
  }
} catch {
  // Network unavailable or timed out — no-op, don't block startup
}

// ── Create server ──────────────────────────────────────────────────────────
const server = new McpServer(
  {
    name: "founders-os",
    version: __boot_pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: `
Founders OS - CRM, tasks, finances, feeds, and memory for founders.

RENDERING CONTRACT. Every render-bearing founders-os tool response includes
a \`render\` field that encodes a four-tier rendering ladder. Follow it on
every response, not just the first.

${RENDERING_CONTRACT}

INTERACTIVE CHOICES. When offering the user multiple discrete options -
whether as part of a conflict response, a confirmation prompt, or any other
multi-option choice point you initiate - use the AskUserQuestion interactive
chooser if it is available in your runtime. Numbered text lists are a
fallback for runtimes without AskUserQuestion, not the default. Any moment
you would otherwise write "1. ..." "2. ..." "3. ..." as a multi-option
prompt in your reply is a moment for the interactive chooser.

FIRST RUN: If get_session_start or get_task_summary returns first_run: true
(or the response includes a _hint field), this is a fresh install with no data.
Offer the user a guided walkthrough instead of presenting empty data. Walk them
through adding their first customer and first task. Keep it conversational -
don't dump everything at once.

DOMAINS:
- CRM: customers (organizations), contacts (people within orgs), interactions
- Tasks: unified task management with personal/org scope, entity linking, and AI assignment
- Finance: accounts, transactions, P&L reporting
- Feeds: RSS/news subscriptions, feed items, bookmarks, digest
- Memory: persistent notes scoped to org (team-wide) or personal (caller only)

SEARCH FIRST: Always call search_customers before add_customer. Always call
search_contacts before add_contact. The returned "id" is the UUID needed for
all follow-on operations.

CONTACTS vs CUSTOMERS: Customers are organizations. Contacts are individual
people. Never search customers by a person's name — use search_contacts.

FINANCE: add_transaction requires a category_id and account_id UUID. Call
list_categories and list_accounts first to get these IDs.

TASKS: Call get_task_summary at the start of each session to surface overdue
items, what's due today, and any tasks assigned to '@claude'. Use list_entity_tasks
to see all tasks linked to a specific customer, transaction, or other entity.
Assign tasks to '@claude' (or self-assign) using create_task or assign_task.
Always call complete_task with a completion_note when finishing AI-assigned work.
Tasks can depend on other tasks via blocked_by_task_id - completing a blocker
surfaces newly unblocked tasks. Use store_as_memory=true on complete_task to
persist important completions as org-scoped memories.

TAGS: Apply prefixes based on conversational context when creating tags:
  - #project for projects, initiatives, deals (e.g. #acme-proposal, #v0.5)
  - @person for people you're waiting on (e.g. @doug, @sarah)
  - !state for meta-states (e.g. !needs-review, !on-hold)
  - No prefix for simple categories (e.g. bug, release, marketing)
When someone mentions a customer/org by name, use link_task to connect the task
to the customer record rather than tagging with the org name. Tags are for
projects and categories, not entity references. The tag validator will catch
some mistakes (typos, known contact names, known customer names), but it cannot
infer project names from conversation - that is your responsibility.

PLAYBOOKS: Call list_playbooks to see available templates. Use get_playbook to inspect
steps before running. run_playbook creates all native tasks and returns external_actions
for the AI to execute immediately using connected MCP tools (GitHub, Slack, Calendar, etc.).
After run_playbook returns, execute every item in external_actions before reporting to user.
Build playbooks with create_playbook + add_playbook_step. All step text supports
{{customer.name}}, {{customer.slug}}, {{contact.primary.name}}, {{playbook.start_date}},
{{playbook.start_date+Nd}}, and {{playbook.start_year}} placeholders.

SURFACES: Call get_session_start at session open for full orientation across all
domains. Use get_entity_card for a complete picture of any customer, contact, or
transaction. get_weekly_retro for completed-task reviews. get_stuck_list for stuck work.

MEMORY: Recalled memories can go stale as the world changes, so a stored memory
may conflict with what you now observe. When that happens, do not blindly trust
the memory or silently overwrite it. First investigate the cause: if you can
track it down, correct the memory and briefly tell the user you did. Ask the
user only when you cannot determine the cause yourself. When you change a memory,
record why it changed via memory_update's change_reason - preserve the reason,
not just the new value.

Call get_usage_guide for full workflows, domain reference, and tips.
Call show_capabilities for example prompts and workflows to try.
    `.trim(),
  }
);

// ── Build the ToolContext once for the process lifetime ────────────────────
// Self-hosted: identity is fixed via env vars, so a single context object
// is reused across every handler call. Domains migrate to receive ctx one
// at a time; until all are migrated, only domains that pass `ctx` to
// registerToolMap get the contextual treatment. See
// docs/multi-deployment-architecture.md for the full plan.
const ctx = buildContext();

// ── Register tools ─────────────────────────────────────────────────────────
registerDiagnosticTools(server, { versionNotice, db: ctx.db });
registerMetaTools(server);
registerCRMTools(server, ctx);
registerTaskTools(server, ctx);
registerTagTools(server, ctx);
registerMemoryTools(server, ctx);
registerFinancialTools(server, ctx);
registerFinancialManagementTools(server, ctx);
registerMemberTools(server, ctx);
registerRSSTools(server, ctx);
registerSurfaceTools(server, ctx);

registerPlaybookTools(server, ctx);
registerGovernanceTools(server, ctx);
registerTriggerTools(server, ctx);
registerProjectTools(server, ctx);
registerRestoreTools(server, ctx);

// Future tool groups:
// registerContractTools(server);  // Planned
// registerScopeTools(server);     // Planned

// ── Start transport ────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
