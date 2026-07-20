// ============================================================
// Founders OS — Meta Tools
// ============================================================
// get_usage_guide — on-demand reference guide covering all six
//   domains (CRM, Tasks, Tags, Finance, Feeds, Memory), surfaces,
//   search protocols, common workflows, and tips & gotchas.
// show_capabilities — example prompts organized by domain.
// list_demos — returns available interactive demo walkthroughs.
//
// Registered directly (not via registerToolMap) because the
// handlers return markdown strings rather than structured JSON.
// ============================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createServiceClient,
  detectFirstRun,
  getCompanyId,
  getPlaceholderIdentityHint,
} from "@ourthinktank/founders-os-core";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const USAGE_GUIDE = `# Founders OS — Usage Guide

## Domain Overview

Eight integrated modules:

1. **CRM** — pipeline management for customer organizations and their contacts
2. **Tasks** — unified task management with entity linking, AI assignment, and dependencies
3. **Tags** — managed tag registry with soft validation across tasks and customers
4. **Finance** — double-entry bookkeeping across named accounts
5. **Feeds** — RSS reader with category filtering and AI digest
6. **Memory** — persistent notes scoped to org (team-wide) or personal (caller only)
7. **Members** — team roster, owner management, onboarding and offboarding
8. **Audit Log** — immutable history of sensitive actions across all domains

Plus **Surfaces** — four cross-domain read views for orientation and retrospectives

---

## CRM

**Customers = organizations. Contacts = people within them. Always separate records.**

### Customer Types
| Value | Meaning |
|-------|---------|
| not_set | Default/unclassified |
| prospect | Early-stage potential customer |
| lead | Qualified interest |
| opportunity | Active deal |
| customer | Paying customer |
| partner | Strategic partner |
| vendor | Supplier |
| other | Catch-all |

### Pipeline Phases
Active: \`prospect\` → \`lead\` → \`opportunity\` → \`customer\` → \`renewal\`
Non-active: \`churned\`, \`inactive\`

### Search Protocol — Always Search Before Creating
1. \`search_customers\` by org name before calling \`add_customer\`
2. \`search_contacts\` by person name — do NOT use search_customers for this
3. \`get_customer\` with a UUID for full detail including contacts and interactions
4. The returned \`id\` field is the UUID needed for all follow-on operations

### Common Workflows

**New org + contact:**
search_customers → add_customer → add_contact (set is_primary: true)

**Log a call or meeting:**
search_customers or search_contacts → get ID → log_interaction (type: "call" | "meeting" | "email" | "note")

**Create a task linked to a customer:**
create_task with title, due_date, links: [{ entity_type: "customer", entity_id: UUID }]

**Mark a task done:**
complete_task with completion_note (always include one for AI-assigned work)

**Pipeline overview:**
get_dashboard — fastest CRM orientation

**Full entity picture:**
get_entity_card(entity_type, entity_id) — bundles entity + open tasks + recent interactions + linked transactions in one call. Use this when you need the complete context for a decision. Use get_customer when you only need CRM-specific data (contacts list, pipeline phase).

**Update customer details:**
update_customer with customer_id + fields to change (organization_name, customer_type, phase, website, tags, notes)

**Update contact details:**
update_contact with contact_id + fields to change (first_name, last_name, email, phone, role, is_primary)

**Remove a contact:**
remove_contact with contact_id

---

## Members

Team members are identified by their FOUNDERS_OS_USER_ID env var value. The company_members
table pairs user IDs with owner status and financial access. Solo installs (no env vars set)
always operate in owner/write mode — no member rows are needed.

### Roles
- **Owner** — can manage members, set financial access, and read the full audit log
- **Member** — can see the member roster and their own audit entries; financial access is set separately

### Common Workflows

**See who's in the company:**
list_members — returns all members with owner status and financial access level

**Onboard a new team member:**
add_member with user_id (the value they'll set as FOUNDERS_OS_USER_ID) and optional display_name

**Make someone an owner:**
set_member_owner with target_user_id and is_owner: true — automatically grants write financial access

**Demote an owner:**
set_member_owner with is_owner: false — there must be at least one other owner remaining

**Offboard a team member:**
remove_member — deletes their company_members row; their historical data is preserved

**Grant or adjust financial access:**
set_financial_access (separate from owner status — a non-owner can have write financial access)

---

## Finance

Accounts are named buckets (checking, savings, credit card, etc.).
Transactions record income/expenses. Categories organize them for reporting.

### Access Control

Financial tools are gated by a per-user access level. If a user lacks access,
any financial tool returns a structured \`permission_denied\` error — relay
the message to the user so they know to ask an owner.

| Level | What it allows |
|-------|----------------|
| \`none\` | No financial tools — not even viewing balances |
| \`read\` | View balances, transactions, categories, P&L |
| \`write\` | Full access — add, edit, delete; implies read |

**Solo installs** (no \`FOUNDERS_OS_USER_ID\` / \`FOUNDERS_OS_COMPANY_ID\` env vars,
or no \`company_members\` row) always default to \`write\` — existing single-user
setups are unaffected.

**Management tools (owner-only):**
- \`set_financial_access\` — grant or restrict a team member's access level
- \`get_financial_access\` — check your own (or any user's) current level
- \`get_audit_log\` — immutable history of every access change with before/after snapshot

Note: An owner cannot downgrade their own access to \`read\` or \`none\` if they
are the last owner in the company — this would lock the org out of financial management.

### Critical: UUID Requirement
\`add_transaction\` requires both \`account_id\` and \`category_id\` as UUIDs.
**Always call \`list_accounts\` and \`list_categories\` first to get these IDs.**

### Common Workflows

**Snapshot:**
get_financial_summary — total assets + YTD income/expense in one call

**P&L detail:**
get_pl_report — breakdown by category

**Add an expense or income:**
list_accounts → list_categories → add_transaction (with account_id, category_id, amount, date)

**Move money between accounts:**
list_accounts → transfer_between_accounts (from_account_id, to_account_id, amount)

**Set up a new account:**
add_account with name and type ("checking" | "savings" | "credit_card" | "investment" | "other")

**Set up a new category:**
add_category with name and type ("income" | "expense")

**Delete a transaction:**
remove_transaction with transaction_id

**List recent transactions:**
list_transactions — returns recent transactions with account and category names

**Grant a team member financial access:**
set_financial_access with target_user_id and level ("none" | "read" | "write")

**Check who can see the books:**
get_financial_access (own access) or get_financial_access with target_user_id (owner only)

**Review access history:**
get_audit_log — immutable log, filterable by action, actor, date range

### Audit Log Coverage
The audit log captures sensitive actions system-wide, not just financial access changes.
Use get_audit_log with the domain filter for targeted views:
- domain: 'financial' — transactions added/deleted, accounts, categories
- domain: 'crm' — customer archives, tag deletes
- domain: 'memory' — org-scoped memory store and forget
- domain: 'playbooks' — playbook runs with customer and task counts
- domain: 'access' — financial access grants and revocations
- domain: 'members' — member add, promote, demote, remove

Any member can call get_audit_log with scope: 'mine' to see their own history.

---

## Feeds

RSS subscriptions with AI-friendly digest generation.

### Common Workflows

**Morning briefing / catch-up:**
get_feed_digest — grouped unread items, optimized for AI summary. Prefer this over list_feed_items for briefings.

**Browse by topic:**
get_feed_digest with a category filter

**Read a specific article:**
read_feed_item with the item ID — returns full content

**Find past coverage:**
search_feed_items with a query string

**Save for later:**
toggle_bookmark on a feed item

**Subscribe to a new feed:**
subscribe_feed with a URL

**Unread count only:**
get_unread_summary — lightweight check without fetching all items

### Tips
- get_feed_digest is faster and better structured for AI summarization than list_feed_items
- Bookmarked items persist across sessions; use list_bookmarks to review saved items
- import_starter_feeds seeds a useful default set of feeds for a new user

---

## Memory

Two scopes: \`"org"\` (visible to all team members) and \`"personal"\` (caller only).

### When to Store
- A preference the user states explicitly ("I prefer weekly reports on Fridays")
- A decision that will affect future behavior ("We're pivoting away from enterprise")
- Context about a customer that doesn't fit CRM fields

### When NOT to Store
- Info already in the CRM — use update_customer or add_contact instead
- Temporary session context — just hold it in the conversation

### Workflow
1. memory_recall — check what's already known before storing
2. memory_store — save a new key/value note
3. memory_summarize_and_store — condense multiple related notes into one
4. memory_forget — remove a specific memory by key

---

## Tasks

Unified task management replacing the old follow_ups system. Personal + org scope. Universal entity linking.

### Session Start Pattern
Call \`get_session_start\` at the beginning of every session. It returns a list of tools to call in parallel for a complete briefing (task summary, stuck list, CRM dashboard, feed headlines). Call all of them, then present the results as a unified morning briefing.

### Task Dependencies
Set \`blocked_by_task_id\` on create_task or update_task to express ordering. Completing a blocker returns \`unblocked_tasks\` in the response.

### AI Assignment
Assign tasks to \`@claude\` via create_task or assign_task. AI agents should always include a \`completion_note\` when calling complete_task.

### Single Owner (ONTG)
Every task has exactly one \`assigned_to\`: the single accountable owner, the "one neck to grab." This is a deliberate design choice, not a missing feature. When responsibility is split across several names, tasks tend to fall through the cracks because no one owns the outcome. To involve more than one person, set the one owner and name the others in the description, or use \`@person\` tags for people you are waiting on. If a user asks why they cannot assign more than one person, explain it this way: it is intentional, and the workaround is to capture collaborators in the description rather than as co-owners.

### Task-to-Memory Bridge
Set \`store_as_memory: true\` on complete_task to persist the completion note as an org-scoped memory. Great for capturing outcomes that matter beyond the task itself.

### Common Workflows

**New task with entity link:**
create_task with title, due_date, priority, links: [{ entity_type, entity_id }]

**Task depending on another:**
create_task with blocked_by_task_id: UUID (auto-sets status to 'blocked')

**Link/unlink entities after creation:**
link_task(task_id, entity_type, entity_id) — connect a task to a customer, contact, transaction, or memory
unlink_task(task_id, entity_type, entity_id) — remove a link

**Delete a task:**
remove_task with task_id

**Weekly review:**
get_weekly_retro — groups completed tasks by tag with completion notes

**Find stuck work:**
get_stuck_list — surfaces stale, blocked, and overdue tasks with triage suggestions

---

## Tags

Managed tag registry with soft validation. Tags are first-class entities with names, slugs, colors, and descriptions.

### Tagging Conventions
Use consistent prefixes to create lightweight structure without new tables:

- **#project** — project grouping: \`#foundersos-v0.4\`, \`#talkdoc-ios\`, \`#mm-campaign\`. Filter with list_tasks(tag='#foundersos-v0.4') for a project view.
- **@person** — waiting on someone: \`@doug\`, \`@accountant\`. Different from assigned_to (who owns it) — this is who you are chasing. The stuck list filters these.
- **!state** — soft meta-state: \`!needs-review\`, \`!shipped-not-announced\`, \`!in-testing\`. Gives you states beyond the four status values.

### Workflow
1. list_tags — see what's registered
2. preview_tags — check how tag names would be classified; returns the same validation warnings as tagging but registers nothing (read-only)
3. create_tag — register a new tag with optional color and description
4. rename_tag with propagate: true — rename across all tasks and customers
5. remove_tag — remove a tag from the vocabulary. Use clean_items: true to also strip it from tasks/customers.

### Validation behavior
Tag validation runs on every create_task and update_task call. It returns structured warnings (each with a \`code\`, \`severity\`, \`suggestion\`) alongside the created/updated task. The tag is still saved - warnings never block.

Four checks run in order:
- **typo** (severity: warning) — tag slug is close to an existing registered tag. NOT auto-registered. Suggestion: the closest match.
- **bare_name** (severity: hint) — tag matches a known contact name without an @ prefix. Auto-registered as-is, but suggests \`@name\`.
- **missing_prefix** (severity: hint) — tag has no #, @, or ! prefix. Suggests the likely prefix based on whether it looks like a state word (!), a person name (@), or a project (#).
- **orphan_prefix** (severity: warning) — bare @ # or ! with nothing after it.

Tags that pass all checks with no close matches are auto-registered in the registry. Auto-registered tags appear in the response as \`tags_auto_registered\`.

### Agent guidance for tag warnings
When \`tag_warnings\` come back in a create_task or update_task response:
- **severity: "warning"** (typo, orphan_prefix) — surface to the user and ask if they want to fix it
- **severity: "hint"** (bare_name, missing_prefix) — mention the convention the first time per session, then silently note it. The tag was already saved; the hint is educational, not blocking.

When translating natural language to tags, apply the prefix automatically:
- Person references ("tag it doug", "waiting on Sarah") -> \`@doug\`, \`@sarah\`
- Project references ("this is for the iOS app", "part of fundraising") -> \`#talkdoc-ios\`, \`#fundraising\`
- State markers ("mark it as needs review", "this is on hold") -> \`!needs-review\`, \`!on-hold\`
Mention the convention the first time per session so the user learns the pattern.

---

## Playbooks

Reusable orchestration templates. Define once, run against any customer to automate full project setup.

### Concepts

- **native_task** steps create Founders OS tasks linked to the customer, with due dates calculated from the run's anchor date.
- **external_action** steps are returned as structured instructions for the AI to execute using connected MCP tools (GitHub, Slack, Calendar, etc.). Founders OS is the orchestration layer; the AI is the executor.
- **Placeholders** resolve at runtime from customer context: \`{{customer.name}}\`, \`{{customer.slug}}\`, \`{{contact.primary.name}}\`, \`{{playbook.start_date}}\`, \`{{playbook.start_date+Nd}}\`, \`{{playbook.start_year}}\`.
- **Graceful degradation**: if a connector is unavailable, use the step's \`fallback_task\` to create a native task instead.

### Common Workflows

**Build a playbook:**
create_playbook → add_playbook_step (repeat) → get_playbook to review

**Inspect requirements before running:**
run_playbook with preflight_only: true → review connector_requirements → run without preflight_only

**Run a playbook:**
run_playbook(playbook_id, customer_id, start_date) → execute external_actions with connected MCP tools → report to user

**Edit a playbook:**
get_playbook → update_playbook_step / add_playbook_step / remove_playbook_step

**Review history:**
list_playbook_runs(customer_id) → get_playbook_run(run_id) for full log

### Rules for AI Agents

1. Always call \`run_playbook\` with \`preflight_only: true\` first if the user hasn't confirmed connector availability.
2. After a normal run, execute EVERY item in \`external_actions\` before reporting completion.
3. If a connector is missing, create a native task using the step's \`fallback_task\` value and tag it \`[manual]\`.
4. Never leave a run in "running" status — always execute external actions or create fallbacks.

---

## Surfaces

Cross-domain read views and session bookends:

- **get_session_start** — session orientation pointer. Returns today's date and a list of tools to call in parallel for a complete briefing. Does not fetch data itself - call the listed tools for the actual content.
- **get_entity_card(entity_type, entity_id)** — complete picture of any entity: record + open tasks + recent interactions + linked transactions
- **get_weekly_retro(week_offset)** — completed tasks grouped by first tag with completion notes. Set format='linkedin' for a ready-to-post draft.
- **get_stuck_list(max_age_days)** — stuck, stale, blocked, and overdue tasks sorted by worst offenders. Each row includes days_stale and a suggested triage action.
- **checkpoint(project)** — end-of-session bookend to get_session_start. Call when the user says "checkpoint" or "wrap up this session". Returns the ordered procedure (summarize, capture repo changes as commit links, store the record, propose task candidates, write the handoff doc), the exact memory_summarize_and_store call to make (kind="checkpoint", resolution="confirm"), and the previous checkpoint for continuity. The agent performs the steps; the tool writes nothing itself.
- **get_project_history(project, kind)** — chronological timeline of a project's stored memories, newest-first. Defaults to kind='checkpoint'; pass kind='all' for every memory. The chronological companion to the semantic memory_recall.
- **get_last_checkpoint(project, author, intent)** - retrieve your most recent checkpoint to show or resume. Pass project ONLY with resolvable context; omit it for a global, cross-project search (never infer one). author defaults to 'me' (your own thread), 'anyone' only on explicit team wording. intent 'show' (default) displays it; 'resume' picks up the work and returns a disambiguation conflict when the target is ambiguous. Read the user's verb to choose intent: "show me"/"what was" = show; "pick up"/"continue"/"resume" = resume.
- **show_capabilities** — example prompts and workflows organized by domain. Call this (or suggest it) when a user asks "what can you do?" or wants to explore features.

---

## Tips & Gotchas

- **UUIDs everywhere**: search/list tools return \`id\` — use that UUID for all follow-on operations
- **Interactions are permanent** — no delete endpoint. Add a corrective note if needed.
- **get_session_start first** — returns which tools to call for a complete briefing. Fastest orientation when asked "what's going on" or "catch me up"
- **Dates**: YYYY-MM-DD for task due dates; ISO 8601 for interaction timestamps
- **Finance setup order**: create accounts -> create categories -> then add transactions
- **Memory scope**: when in doubt, use \`"personal"\` to avoid polluting shared org memory
- **Feeds vs training data**: for current news or recent events, call get_feed_digest rather than answering from training data
- **Tags auto-register**: new tags with no close matches are added to the registry automatically. You only get warnings when a tag looks like a typo of an existing one.
- **Tag convention nudges**: the server checks tags against known contacts and prefix conventions. Surface "warning" severity to the user; handle "hint" severity quietly.

## Demos

Interactive demo walkthroughs are bundled with the package. Call \`list_demos\` to see what's available and get instructions for running them. Demos create temporary data, walk the user through scenarios, and clean up afterwards.
`;

const CAPABILITIES = `# Founders OS - What Can I Do?

Here are example prompts you can try, organized by what you want to accomplish. Just ask naturally - these are starting points, not exact commands.

---

## CRM - Manage your pipeline and relationships

- "Add Acme Corp as a new prospect"
- "Who are my current customers?"
- "What's going on with Orbyte?" (uses entity card for full picture)
- "Log a call with Acme - we discussed pricing and they want a proposal by Friday"
- "Show me customers I haven't talked to in a while"
- "Move Acme from lead to opportunity"
- "Add Sarah Chen as the primary contact at Acme - she's the CTO"

## Tasks - Track work across everything

- "What's on my plate today?" (uses session start dashboard)
- "Create a task: send proposal to Acme, due Friday, high priority"
- "What tasks are linked to Orbyte?"
- "Show me stuck or overdue tasks" (uses stuck list)
- "Mark the Acme proposal task as done - sent via email, they'll review next week"
- "Create a task for @claude: research competitors in the AI photo space"
- "What did I get done last week?" (uses weekly retro)
- "Tag the proposal task with #acme-deal and @sarah"

## Finance - Track money in and out

- "What's my financial summary?"
- "How's my P&L looking this month?"
- "Log a $500 expense for software subscriptions from checking"
- "Transfer $2,000 from checking to savings"
- "Show me recent transactions"
- "Set up a new expense category for marketing"

## Feeds - Stay current on news and trends

- "What's new in my feeds?" (morning briefing via digest)
- "Search my feeds for anything about AI regulation"
- "Subscribe to this RSS feed: https://example.com/feed.xml"
- "Bookmark that article about startup fundraising"
- "How many unread items do I have?"

## Memory - Remember what matters

- "Remember that we're pivoting away from enterprise sales"
- "What do you know about our pricing strategy?"
- "Store a note: Andy prefers async communication, no meetings before noon"
- "What preferences have I told you about?"

## Playbooks - Automate project setup

- "Show me my playbooks"
- "Create a playbook for onboarding new clients"
- "What does the New Deal playbook need before I run it?" (preflight check)
- "Run the new-deal playbook for Acme Corp starting today"
- "Show me all playbook runs for Acme Corp"
- "Add a step to the onboarding playbook: send welcome email, due in 2 days"

## Cross-domain workflows

- "Catch me up" (session start - calls task summary, stuck list, dashboard, feeds in parallel)
- "Prepare a LinkedIn post about what I shipped this week" (weekly retro with linkedin format)
- "What should I focus on right now?" (session start briefing)
- "Give me the full picture on Acme Corp" (entity card - record, tasks, interactions, transactions)
- "Triage my stuck tasks" (stuck list with suggested actions per item)

---

**Tip:** You can ask "show me the usage guide" for the full technical reference with all tool parameters and search protocols.
`;

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "get_usage_guide",
    {
      title: "Usage Guide",
      description:
        "Returns a detailed guide on how to use Founders OS - covering all six domains (CRM, Tasks, Tags, Finance, Feeds, Memory), surface tools, search protocols, common workflows, and tips. Call this when uncertain about how to approach a task.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: USAGE_GUIDE,
        },
      ],
    })
  );

  server.registerTool(
    "show_capabilities",
    {
      title: "Show Capabilities",
      description:
        "Returns example prompts and workflows organized by domain (CRM, Tasks, Finance, Feeds, Memory, Surfaces). " +
        "Call this when a user asks 'what can you do?', 'show me what I can do', 'help me get started', " +
        "or wants to explore what Founders OS offers. Lighter than the full usage guide - focused on " +
        "natural-language examples rather than technical reference.",
      inputSchema: {},
    },
    async () => {
      const content: { type: "text"; text: string }[] = [
        { type: "text", text: CAPABILITIES },
      ];

      try {
        const supabase = createServiceClient();
        const companyId = getCompanyId();
        if (await detectFirstRun(supabase, companyId)) {
          content.push({
            type: "text",
            text:
              "\n\n_hint: This is a fresh install with no data yet. Walk the user through " +
              "adding their first customer and creating their first task to get them " +
              "started with real data. Keep it conversational.",
          });
        }
      } catch {
        // If DB check fails, skip the hint - the capabilities content is still useful.
      }

      // Surface the placeholder-identity nudge independently of the DB check:
      // a fresh user on the sample identity should be told even if the DB is
      // unreachable. Null once both env vars are configured.
      const identityHint = getPlaceholderIdentityHint();
      if (identityHint) {
        content.push({ type: "text", text: `\n\n_hint: ${identityHint}` });
      }

      return { content };
    }
  );

  server.registerTool(
    "list_demos",
    {
      title: "List Demos",
      description:
        "Returns available interactive demo walkthroughs bundled with Founders OS. " +
        "When called without a name, returns a summary list of available demos. " +
        "When called with a demo name, returns the full script (with shared " +
        "presentation rules prepended) so the AI agent can run it directly. " +
        "Call this when a user asks about demos, wants to explore features, " +
        "or is onboarding.",
      inputSchema: {
        name: z.string().optional().describe(
          "Demo name to load (e.g. 'conflict-resolution-walkthrough'). " +
          "Omit to list all available demos."
        ),
      },
    },
    async (params: { name?: string }) => {
      // Resolve demos dir relative to this file, tolerant of how the
      // server is launched. In the normal (published/built) case this file is
      // dist/tools/meta.js and demos live at dist/demos (../demos). The
      // src/tools path is the local-development case: the server is run
      // straight from the TypeScript source, so this file is src/tools/meta.ts
      // and demos live at packages/mcp-server/demos (../../demos). Probe both
      // so list_demos works in either layout.
      const thisFile = fileURLToPath(import.meta.url);
      const thisDir = path.dirname(thisFile);
      const demosCandidates = [
        path.resolve(thisDir, "../demos"), // built: dist/tools -> dist/demos
        path.resolve(thisDir, "../../demos"), // local dev: src/tools -> packages/mcp-server/demos
      ];
      const demosDir = demosCandidates.find((dir) => existsSync(dir)) ?? demosCandidates[0];

      try {
        const files = await readdir(demosDir);
        // Exclude non-demo files (shared rules, contributor guides)
        const nonDemoFiles = new Set(["DEMO_RULES.md", "HOW_TO_CREATE_DEMOS.md"]);
        const mdFiles = files.filter((f) => f.endsWith(".md") && !nonDemoFiles.has(f));

        if (mdFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  demos: [],
                  message: "No demo scripts found. The demos directory may not have been installed.",
                }),
              },
            ],
          };
        }

        // If a specific demo was requested, return its full content
        // with shared presentation rules prepended
        if (params.name) {
          const fileName = params.name.endsWith(".md") ? params.name : `${params.name}.md`;

          // Security: whitelist against the files returned by readdir() so that
          // path traversal sequences (e.g. "../../etc/passwd") are rejected
          // before we ever touch the filesystem with the caller-supplied value.
          if (!mdFiles.includes(fileName)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Demo "${params.name}" not found.`,
                    available: mdFiles.map((f) => f.replace(/\.md$/, "")),
                  }),
                },
              ],
            };
          }

          // Defense-in-depth: confirm the resolved path stays inside demosDir
          const filePath = path.join(demosDir, fileName);
          const resolvedPath = path.resolve(filePath);
          if (!resolvedPath.startsWith(path.resolve(demosDir) + path.sep)) {
            throw new Error("Invalid demo name.");
          }

          const demoContent = await readFile(filePath, "utf-8");

          // Prepend shared rules so the agent gets everything in one read
          let combined = demoContent;
          const rulesPath = path.join(demosDir, "DEMO_RULES.md");
          try {
            const rulesContent = await readFile(rulesPath, "utf-8");
            combined = rulesContent + "\n\n---\n\n" + demoContent;
          } catch {
            // DEMO_RULES.md missing - proceed with demo content only
          }

          return {
            content: [
              {
                type: "text" as const,
                text: combined,
              },
            ],
          };
        }

        // Otherwise return a summary list
        const categoryOrder: Record<string, number> = {
          welcome: 0,
          domain: 1,
          functional: 2,
        };

        const demos = await Promise.all(
          mdFiles.map(async (f) => {
            const filePath = path.join(demosDir, f);
            const content = await readFile(filePath, "utf-8");

            // Parse optional YAML frontmatter for category
            const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
            const catMatch = fmMatch?.[1]?.match(/^category:\s*(.+)/m);
            const category = catMatch?.[1]?.trim() ?? "functional";

            const titleMatch = content.match(/^#\s+(.+)/m);
            const descMatch = content.match(
              /\*\*What is this\?\*\*\s*(.+?)(?:\n>\s*\n|\n\n|$)/s
            );

            return {
              name: f.replace(/\.md$/, ""),
              title: titleMatch?.[1] ?? f,
              description: descMatch?.[1]?.trim() ?? "Interactive demo walkthrough",
              category,
            };
          })
        );

        // Sort: welcome first, then domain, then functional
        demos.sort((a, b) => {
          const aOrder = categoryOrder[a.category] ?? 99;
          const bOrder = categoryOrder[b.category] ?? 99;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.title.localeCompare(b.title);
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  demos,
                  ai_guidance:
                    "To run a demo, call list_demos again with the demo name to get " +
                    "the full script, then follow the instructions inside. Each demo " +
                    "creates temporary data, walks the user through scenarios, and " +
                    "cleans up at the end. Demos are sorted by category: welcome " +
                    "demos first, then domain-specific demos, then functional demos. " +
                    "When presenting demos to the user, group them under their " +
                    "category name (Welcome, Domain, Functional) with a blank line " +
                    "before each group heading.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                demos: [],
                message: `Could not read demos: ${message}`,
              }),
            },
          ],
        };
      }
    }
  );
}
