# Founders OS

**Open-source MCP server for startup and small business founders.**

Founders OS gives you a complete business context - CRM, projects, tasks, finances, feeds, memory, playbooks - accessible from Claude, Cursor, or any MCP-compatible AI client. One connection, your entire business.

Built by [OurThinkTank](https://ourthinktank.com). Marketing site at [foundersmcp.com](https://foundersmcp.com).

New to AI tools, or handing this to someone who is? Start with [Read This First](https://foundersmcp.com/docs/read-this-first/) - a plain-language intro to what FoundersOS is and isn't, what AI assistants can and can't do, and the habits that keep them honest.

<p align="center">
  <img src=".github/assets/start-my-day.gif" alt="Founders OS in action: typing 'start my day' produces a full morning briefing - tasks due today, work assigned to AI, and feed headlines." width="760">
</p>

## What's Included

| Module | Tools | Description |
|---|---|---|
| **CRM** | 13 | Customers, contacts, interactions, pipeline dashboard |
| **Tasks** | 12 | Tasks with entity linking, AI assignment, dependencies, progress notes |
| **Projects** | 5 | First-class project records anchored on a project tag, with task rollups |
| **Playbooks** | 11 | Reusable orchestration templates that fan out to tasks and external MCP actions |
| **Tags** | 4 | Shared tag registry with soft validation and auto-registration |
| **Financial** | 14 | Double-entry ledger, P&L, multi-company, per-user access control |
| **Feeds** | 13 | RSS/Atom/JSON reader, briefings, bookmarks, pins |
| **Memory** | 5 | Semantic memory with personal + org scopes, pgvector, dedup, metadata filters |
| **Surfaces** | 6 | Cross-domain reads: session start, entity cards, weekly retro, stuck list, session checkpoints, project history |
| **Members** | 4 | Org membership directory, owner designation |
| **Audit + Restore** | 2 | Full audit log; soft-delete recovery |
| **Diagnostic** | 5 | Ping, version, usage guide, capability explorer, demos |

94 tools total across 12 modules.

## Quick Start

You need a Supabase project, an embedding API key (OpenAI by default), and an MCP-capable AI client.

### 1. Set up Supabase

Create a [Supabase](https://supabase.com) project, then in the SQL Editor run `supabase/setup.sql`. This single file sets up the full schema from scratch — extensions (`vector`, `uuid-ossp`, `pg_trgm`), all tables, indexes, RLS policies, functions, views, maintenance jobs, and the Data API grants required for compatibility with Supabase's [removal of automatic default privileges](https://github.com/orgs/supabase/discussions/45329) for projects created on or after 2026-05-30. The wizard at [foundersmcp.com/setup](https://foundersmcp.com/setup) prints the same SQL with the embedding dimension already matched to your provider — prefer it if you are not using the default dimension.

### 2. Connect your AI client

The Founders OS MCP server runs through `npx`. Every client - Claude Desktop, Cowork, Cursor, Continue.dev, Zed, or any spec-compliant MCP client - uses the same configuration.

The quickest way is the wizard at [foundersmcp.com/setup](https://foundersmcp.com/setup): enter your Supabase and embedding credentials and it generates a filled-in config for you to copy or download. Your credentials never leave the browser. You can also paste the block below by hand.

Drop this into your client's `mcp.json` (in Claude Desktop, this is the MCP servers section of your config):

```json
{
  "mcpServers": {
    "founders-os": {
      "command": "npx",
      "args": ["-y", "@ourthinktank/founders-os@latest"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_...",
        "FOUNDERS_OS_COMPANY_ID": "your-company",
        "FOUNDERS_OS_USER_ID": "your-name",
        "FOUNDERS_OS_TIMEZONE": "America/Los_Angeles",
        "EMBEDDING_PROVIDER": "openai",
        "EMBEDDING_MODEL": "text-embedding-3-small",
        "EMBEDDING_DIM": "1536",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

See [Environment variables](#environment-variables) for the full list and provider options.

### 3. Try it

```
What can you do?                                  -> show_capabilities
Catch me up                                       -> get_session_start
Add Acme Corp as a new prospect                   -> add_customer
Log a call with Sarah at Acme - discussed pricing -> log_interaction
Create a task to send the proposal by Friday      -> create_task + link_task
What's stuck or overdue?                          -> get_stuck_list
Show me everything about Acme Corp                -> get_entity_card
Remember for the org: targeting SMB fintech in Q3 -> memory_store
Show me OTT's P&L for Q1                          -> get_pl_report
Run the customer-onboarding playbook for Acme     -> run_playbook
Give me my weekly retro for LinkedIn              -> get_weekly_retro
Let's checkpoint - wrap up this session           -> checkpoint
What's happened on founders-os lately?            -> get_project_history
```

---

## CRM (13 tools)

Pipeline management for customer organizations and the contacts inside them. Customers are organizations; contacts are people - always separate records, so you can move a contact between customers without losing history.

**Customers:** `add_customer`, `get_customer`, `update_customer`, `remove_customer`, `search_customers`, `list_customers`

**Contacts:** `add_contact`, `update_contact`, `remove_contact`, `search_contacts`

**Interactions:** `log_interaction`, `list_interactions`

**Dashboard:** `get_dashboard`

**Pipeline phases:** `prospect` -> `lead` -> `opportunity` -> `customer` -> `renewal` (plus `churned`, `inactive`).

---

## Tasks (12 tools)

Unified task management with org and personal scopes, entity linking, AI assignment, task dependencies, progress notes, and a task-to-memory bridge.

`create_task`, `get_task`, `update_task`, `complete_task`, `remove_task`, `list_tasks`, `link_task`, `unlink_task`, `list_entity_tasks`, `add_task_note`, `assign_task`, `get_task_summary`

**Scopes:** `org` (team-visible, default) and `personal` (private to creator).

**AI assignment:** Use `@claude` or `@gpt` as the assignee. `get_task_summary` surfaces a dedicated AI work queue. `list_tasks(assigned_to='@claude')` filters to AI-assigned work.

**Dependencies:** Set `blocked_by_task_id` on a task. Completing the blocker surfaces `unblocked_tasks` in the response.

**Task-to-memory bridge:** When completing a task, set `store_as_memory=true` to persist the completion note as an org-scoped memory entry.

**Entity linking:** Tasks can link to customers, contacts, interactions, transactions, projects, playbooks, memories, or any other entity type via the `task_links` junction table. Link at creation time or later with `link_task`.

---

## Projects (5 tools)

Projects are first-class records anchored on a project tag (e.g. `#acme-rebuild`). `get_project` returns the project card with status, the linked tag, recent tasks grouped by status, and any customers tagged into it.

`create_project`, `get_project`, `update_project`, `remove_project`, `list_projects`

`list_projects` also flags any `#`-prefixed tags in the registry that don't yet have a project record, so the registry and the projects directory stay in sync.

---

## Playbooks (11 tools)

Named, reusable orchestration templates. A playbook is defined once and run against a customer (or other subject) to spin up a complete project: it creates native Founders OS tasks AND, when connected MCP tools are present, fires external actions like creating a GitHub repo, posting to Slack, or scheduling a calendar event. If a connector is not available, the step gracefully falls back to a tagged `[manual]` task so the playbook still works.

`create_playbook`, `get_playbook`, `update_playbook`, `remove_playbook`, `list_playbooks`, `add_playbook_step`, `update_playbook_step`, `remove_playbook_step`, `run_playbook`, `get_playbook_run`, `list_playbook_runs`

**Step types:** `native_task` (Founders OS task) or `external_action` (MCP tool call). External steps carry a `connector`, an `action`, and a `params` object with placeholders.

**Placeholders:** `{{customer.name}}`, `{{customer.slug}}`, `{{playbook.start_date}}`, `{{playbook.start_date+Nd}}`, `{{contact.primary.name}}`, `{{memory:key}}` resolved at runtime.

**Run log:** `get_playbook_run` returns the full execution log; `list_playbook_runs` shows history per playbook.

---

## Tags (4 tools)

Shared tag registry with soft validation. Tags are advisory: unrecognized tags warn but never block operations, and new tags auto-register on first use.

`list_tags`, `create_tag`, `rename_tag`, `remove_tag`

**Conventions:** `#project-name` for projects, `@person` for people, `!state` for meta-states (e.g. `!needs-review`). Simple category words like `bug` or `release` are fine unprefixed.

**Validation checks:** typo detection against existing tags, known-contact detection (nudges toward `@`), known-customer detection (nudges toward entity linking), and state-word detection (nudges toward `!`).

---

## Financial (14 tools)

Simple double-entry ledger scoped by `FOUNDERS_OS_COMPANY_ID`, with per-user access control so company books can be opened to specific teammates only.

`add_transaction`, `list_transactions`, `remove_transaction`, `add_category`, `list_categories`, `remove_category`, `add_account`, `list_accounts`, `remove_account`, `transfer_between_accounts`, `get_pl_report`, `get_financial_summary`, `get_financial_access`, `set_financial_access`

**Multi-company:** Set a different `FOUNDERS_OS_COMPANY_ID` per instance to keep books separate.

**Access control:** `set_financial_access` grants or revokes a member's access to a company's financial tools. `get_financial_access` reports the current grants. By default the owner of a `FOUNDERS_OS_COMPANY_ID` has access; everyone else is locked out until explicitly granted.

---

## Feeds (13 tools)

Built-in feed reader (RSS, Atom, JSON Feed) with a Postgres-backed store. Subscribe, brief, search, bookmark, pin.

**Subscriptions:** `subscribe_feed`, `unsubscribe_feed`, `list_feeds`, `refresh_feeds`, `import_starter_feeds`, `pin_feed`, `unpin_feed`

**Items:** `get_feed_items`, `read_feed_item`, `get_feed_briefing`

**Bookmarks:** `bookmark_item`, `remove_bookmark`, `list_bookmarks`

**Categories:** `tech`, `startups`, `business`, `finance`, `product`, `design`, `engineering`, `ai`, `crypto`, `science`, `news`, `personal`, `other`.

---

## Memory (5 tools)

Semantic memory backed by pgvector with personal and org scopes, near-duplicate detection, metadata filters, and pagination.

`memory_store`, `memory_recall`, `memory_update`, `memory_forget`, `memory_summarize_and_store`

**Scopes:**
- `org` - visible to all team members pointing at the same Supabase project
- `personal` - visible only to the user whose `FOUNDERS_OS_USER_ID` matches

**Filters on `memory_recall`:** `min_score`, `source_tool`, `created_after`, `created_before`, `offset`, `limit`, `project`, `scope`.

**Dedup:** `memory_store` and `memory_summarize_and_store` check for existing memories with cosine similarity >= 0.92 and surface a conflict with options to force-store or skip.

**Embedding providers** (set via `EMBEDDING_PROVIDER`):

| Provider | Default model | Dims | Credentials |
|----------|--------------|------|-------------|
| `openai` (default) | `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` |
| `bedrock` | `amazon.nova-2-multimodal-embeddings-v1:0` | 1024 | AWS credential chain |
| `ollama` | `nomic-embed-text` | 768 | `OLLAMA_BASE_URL` |

> Set `EMBEDDING_DIM` to match the model before running `002_memory_schema.sql`. The dimension is permanent - changing providers later requires re-embedding the memory table.

---

## Surfaces (6 tools)

Cross-domain read views that compose data from tasks, CRM, finance, and feeds into ready-to-render dashboards for AI agents.

| Tool | What it returns |
|------|-----------------|
| `get_session_start` | Orientation dashboard: task signals, AI queue, finance pulse, CRM activity, feed unread counts, suggested actions, first-run flag, and the four-tier rendering contract. Call at the start of every session. |
| `get_entity_card` | Complete picture of any entity (customer, contact, transaction, project) with open tasks, recent interactions, and linked records in one call. |
| `get_weekly_retro` | Completed-task retrospective grouped by tag with completion notes. Can format as a LinkedIn-ready draft. |
| `get_stuck_list` | Surfaces stuck, stale, and overdue tasks that need triage, with days-stale counts and suggested actions. |
| `checkpoint` | End-of-session bookend to `get_session_start`. Returns the ordered wrap-up procedure (summarize, capture repo changes as commit links, store the record, propose follow-up tasks, write the handoff doc), the exact memory call to make, and the previous checkpoint so open items carry forward. Rides memory - no new entity, no migration. |
| `get_project_history` | Chronological, newest-first timeline of a project's checkpoints; the "what happened, in order" companion to semantic memory recall. Pass `kind: 'all'` for every memory, not just checkpoints. |

---

## Members (4 tools)

Org membership directory. Maps `FOUNDERS_OS_USER_ID` slugs to display names, marks the owner of a company, and supports adding or removing members.

`add_member`, `list_members`, `remove_member`, `set_member_owner`

The owner of `FOUNDERS_OS_COMPANY_ID` is the default holder of financial access; others get access via `set_financial_access`.

---

## Audit and Restore (2 tools)

`get_audit_log` returns the structured audit trail across all domains (creates, updates, deletes, restores, financial access changes, playbook runs).

`restore_item` reverses a soft delete on any soft-deleted record type, returning the record to its previous state. Use the audit log to find the original delete event and the entity ID to restore.

---

## Diagnostic and Meta (5 tools)

| Tool | Description |
|------|-------------|
| `ping` | Connectivity test. Embeds an update notice if a newer package version is available. |
| `get_version` | Running package version, rendering contract version, and the latest npm-published version. |
| `get_usage_guide` | On-demand reference covering modules, conventions, and common workflows. |
| `show_capabilities` | Friendly overview with example prompts for each module. |
| `list_demos` | Lists or runs the bundled interactive walkthroughs (welcome tour, conflict resolution, run-my-week, etc.). |

---

## Rendering contract

Render-bearing tools include a `render` field with a four-tier ladder so the AI client picks the most visual output it supports: visual primitive tool (artifact/widget/canvas), inline rich output (HTML/SVG/JSX), markdown table, then prose. The contract ships in three channels in attention-strength order:

1. **Server `instructions` field** at MCP registration - loaded at connect. All spec-compliant MCP clients.
2. **`get_session_start.rendering_contract`** - full ladder text on session orientation. All clients.
3. **Per-response `rendering_contract` reminder** - self-contained short form. Cold-start safety net.

The canonical source lives in `packages/mcp-server/src/contract.ts`, so every MCP client gets rich rendering through these channels with no plugin required. (A Claude plugin that mirrors the contract at system-prompt position, for stronger adherence in long sessions, is planned for a later release and is not part of this one.) Current `contract_version` is `4`; a mismatch surfaces as `contract_version_warning` on `get_session_start` and `get_version`.

---

## First-run onboarding

When the database is empty, tools attach onboarding hints to their responses. `get_session_start` detects a fresh install and suggests a guided walkthrough: add a first customer, create a first task, and optionally set up finance accounts. This keeps the experience conversational rather than dumping all 92 tools at once.

For a guided tour of a specific feature, ask the AI to "run the welcome demo" or "show me the conflict-resolution walkthrough" - `list_demos` returns the bundled interactive scripts.

---

## Environment variables

```bash
# Supabase (required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...

# Identity - set distinct values per teammate so personal memory scopes work
FOUNDERS_OS_USER_ID=your-name            # defaults to "default"
FOUNDERS_OS_COMPANY_ID=your-company      # defaults to "default"
FOUNDERS_OS_TIMEZONE=America/Los_Angeles # used by date-aware tools and YTD math

# Embedding provider for memory tools
EMBEDDING_PROVIDER=openai                # openai | bedrock | ollama
EMBEDDING_MODEL=text-embedding-3-small   # provider default used if omitted
EMBEDDING_DIM=1536                       # MUST match the vector() size in 002_memory_schema.sql

# OpenAI (required if EMBEDDING_PROVIDER=openai)
OPENAI_API_KEY=sk-...

# Bedrock (uses AWS credential chain - no key needed on AWS with IAM role)
# AWS_DEFAULT_REGION=us-east-1
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...

# Ollama (required if EMBEDDING_PROVIDER=ollama)
# OLLAMA_BASE_URL=http://localhost:11434
```

---

## Development

```bash
# Clone
git clone https://github.com/ourthinktank/founders-os.git
cd founders-os

# Install
npm install

# Build
npm run build

# Watch
npm run dev
```

### Project structure

```
founders-os/
├── packages/
│   ├── mcp-server/                  # @ourthinktank/founders-os npm package
│   │   ├── src/
│   │   │   ├── index.ts             # Entry point (stdio transport)
│   │   │   ├── supabase.ts          # Database client
│   │   │   ├── contract.ts          # Canonical rendering contract
│   │   │   └── tools/
│   │   │       ├── crm/             # Customers, contacts, interactions, dashboard
│   │   │       ├── tasks/           # Task management
│   │   │       ├── projects/        # Project records
│   │   │       ├── playbooks/       # Reusable orchestration templates
│   │   │       ├── tags/            # Shared tag registry
│   │   │       ├── financial/       # Ledger + access control
│   │   │       ├── rss/             # Feed reader
│   │   │       ├── memory/          # Semantic memory
│   │   │       ├── surfaces/        # Cross-domain reads
│   │   │       ├── members/         # Org directory
│   │   │       ├── audit.ts         # Audit log
│   │   │       ├── restore.ts       # Soft-delete recovery
│   │   │       ├── diagnostic.ts    # Ping + version
│   │   │       ├── meta.ts          # Usage guide + capabilities + demos
│   │   │       ├── first-run.ts     # Empty-database hints
│   │   │       ├── dates.ts         # Date/timezone helpers
│   │   │       └── permissions.ts   # Financial access checks
│   │   └── demos/                   # Interactive walkthrough scripts
├── integrations/
│   └── setup-page/                  # Config wizard hosted at foundersmcp.com/setup
├── supabase/
│   ├── setup.sql                    # Complete schema for fresh installs (run once)
│   └── migrations/                  # Future schema changes (currently empty)
├── docs/                            # Specs and design docs
└── README.md
```

### Local install for testing

Build, then point your MCP client at the local entry instead of npx:

```json
{
  "mcpServers": {
    "founders-os": {
      "command": "node",
      "args": ["/absolute/path/to/founders-os/packages/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_...",
        "FOUNDERS_OS_USER_ID": "your-name",
        "FOUNDERS_OS_COMPANY_ID": "your-company",
        "EMBEDDING_PROVIDER": "openai",
        "EMBEDDING_DIM": "1536",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

---

## Contributing

Founders OS is open source under the MIT license. Outside contributions are not being accepted yet - that's coming soon. In the meantime, issue reports are welcome and very much encouraged: please file them on [GitHub](https://github.com/ourthinktank/founders-os/issues). See [CONTRIBUTING.md](CONTRIBUTING.md) for how to file a good report, and our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should go through [SECURITY.md](SECURITY.md), not public issues.

## License

MIT - see [LICENSE](LICENSE).
