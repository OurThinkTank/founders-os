# Adding Tools to Founders OS MCP Server

This document is the canonical reference for how tools are structured and registered in this package. Follow it whenever adding a new tool or a new domain, whether working solo or with an AI assistant.

---

## The Two Patterns

There are exactly two acceptable patterns. Use Pattern A by default. Use Pattern B only when a tool needs shared stateful infrastructure created at registration time.

> **Migration in progress (2026-05).** Pattern A is splitting into A-legacy (the original env-reading shape) and A-contextual (handler receives a `ToolContext`). **New tools should use the A-contextual shape.** Existing tools migrate one at a time; both shapes coexist in the same map. See "Pattern A-contextual" below and `docs/multi-deployment-architecture.md` for the design.

---

### Pattern A — Tool Map (default)

Use this for all stateless tools: tools that read from env vars, create their own DB clients inline, or call module-level helpers. This covers CRM, Memory, Financial, and any new domain that doesn't need shared in-memory state.

**How it works:**

A tool file exports a plain `ToolMap` object. Each key is the tool name; each value is `{ title, description, parameters, handler }`. The handler returns a plain object or throws an `Error` — it never constructs an MCP content envelope directly. The `registerToolMap` helper handles the envelope, the `JSON.stringify`, and the try/catch for every tool in one place.

**File layout for a new domain:**

```
src/tools/
  my-domain/
    index.ts      ← exports myDomainTools (ToolMap) + registerMyDomainTools()
    helpers.ts    ← shared helpers, if needed (optional)
```

**Template — `src/tools/my-domain/index.ts`:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import { createServiceClient } from "../../supabase.js";

// Helper for multi-tenant scoping (copy the pattern from financial or memory)
function getCompanyId(): string {
  return process.env.FOUNDERS_OS_COMPANY_ID ?? "default";
}

export const myDomainTools: ToolMap = {
  // Tool name becomes the MCP tool name exactly as written here
  do_something: {
    title: "Do Something",            // Human-readable name shown in tool UIs
    description:
      "One or two sentences. What does this tool do and when should the AI call it?",
    parameters: z.object({
      required_field: z.string().describe("Description of this field."),
      optional_field: z.number().optional().describe("Description. Default X."),
    }),
    handler: async ({ required_field, optional_field = 0 }: {
      required_field: string;
      optional_field?: number;
    }) => {
      const supabase = createServiceClient();
      const { data, error } = await supabase
        .from("my_table")
        .select("*")
        .eq("company_id", getCompanyId());

      // Throw on failure — registerToolMap catches it and returns { error: message }
      if (error) throw new Error(`Failed to do something: ${error.message}`);

      // Return a plain object — registerToolMap wraps it in JSON.stringify
      return data;
    },
  },

  do_something_else: {
    // ... same structure
  },
};

export function registerMyDomainTools(server: McpServer): void {
  registerToolMap(server, myDomainTools);
}
```

**Adding a tool to an existing domain** is even simpler — just add a new key to the existing `ToolMap` export in that domain's `index.ts`. No changes needed anywhere else.

---

### Pattern A-contextual — Tool Map with ToolContext (recommended for new tools)

This is the migration target for every Pattern A tool. The handler signature changes from `(params)` to `(ctx, params)` where `ctx: ToolContext` carries the Supabase clients, identity, and other per-request state. Tools never call `createServiceClient()`, `getCompanyId()`, or `getUserId()` directly.

The motivation is described in `docs/multi-deployment-architecture.md`: the same tool logic must run under self-hosted (service-role client, identity from env) and the future hosted service (user-scoped JWT client, identity from token claims) without two copies of every handler.

`registerToolMap` detects which shape a handler uses via its declared `.length` and routes accordingly. Legacy and contextual handlers can coexist in the same map during the migration.

**File layout is unchanged.** Only the handler signature and body differ.

**Template:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerToolMap, type ToolMap } from "../register.js";
import type { ToolContext } from "../../types/context.js";

export const myDomainTools: ToolMap = {
  do_something: {
    title: "Do Something",
    description: "...",
    parameters: z.object({
      required_field: z.string().describe("Description."),
    }),
    handler: async (ctx: ToolContext, { required_field }: {
      required_field: string;
    }) => {
      const { data, error } = await ctx.db
        .from("my_table")
        .select("*")
        .eq("company_id", ctx.companyId);

      if (error) throw new Error(`Failed: ${error.message}`);
      return data;
    },
  },
};

export function registerMyDomainTools(server: McpServer, ctx: ToolContext): void {
  registerToolMap(server, myDomainTools, ctx);
}
```

**Wiring in `src/index.ts`:** the top-level entry point builds the context once via `buildContext()` and passes it to every domain registrar that accepts one. Legacy registrars (still on env-reading handlers) are called without ctx; the signature stays compatible.

```typescript
import { buildContext } from "./context.js";

const ctx = buildContext();

registerMyDomainTools(server, ctx);   // contextual
registerLegacyDomainTools(server);    // legacy (no ctx)
```

**`ctx.db` vs `ctx.admin`:**

- `ctx.db` is the default. Under self-hosted it is the service-role client; under hosted it is the user-scoped client subject to RLS. Always pair `.eq("company_id", ctx.companyId)` with reads/writes here so the filter holds under both modes.
- `ctx.admin` is the service-role client even under hosted mode. Use only for legitimately privileged operations: audit-log writes, background jobs, migrations. Any handler that calls `ctx.admin` must include a brief inline comment explaining why bypass is needed.

**Lint enforcement.** `__tests__/tool-context-lint.test.ts` maintains an allowlist of migrated files and asserts that their contextual handlers do NOT call `createServiceClient()`, `getCompanyId()`, or `getUserId()` in their bodies. When you migrate a tool, add the file path to `CONTEXTUAL_FILES` in that test. The lint then prevents regression and the next migration starts where this one left off. If a contextual handler genuinely needs direct service-role access (extremely rare), append the marker `// lint: tool-context allow-direct-client` to the call line with a justification.

**Migration order (loose):** CRM → Tasks → Memory → Financial → RSS → Surfaces → Playbooks → Projects → Members. Domains can move independently; the only ordering constraint is within a domain (its `register*Tools` registrar starts taking `ctx` once any of its tools become contextual).

---

### Pattern B — Sub-Registrar (stateful or non-JSON tools)

Use this when tools in a domain need a shared object instance that is created once at startup and passed into every handler — for example, an open file handle, a connection pool, or an in-memory cache. The RSS domain uses this because all RSS tools share a single `FeedStore` instance.

Also use Pattern B when a tool returns pre-formatted text (e.g. markdown) rather than structured data. Pattern A's `registerToolMap` runs `JSON.stringify` on the return value, which would escape the formatting. The meta tools (`get_usage_guide`, `show_capabilities`) use direct registration for this reason.

**How it works:**

The domain's `index.ts` exports a `register*Tools(server, sharedThing)` function. Inside, it calls `server.registerTool(...)` directly for each tool, closing over `sharedThing`. Handlers return MCP content envelopes directly (the `{ content: [{ type: "text", text: "..." }] }` shape) because there is no `registerToolMap` wrapper.

**When NOT to use Pattern B:**

If your tools just call `getCompanyId()` or `createServiceClient()` inline, that is not stateful in the relevant sense — use Pattern A. Pattern B is only for cases where a single object instance must be shared across all tool calls (e.g., you can't just call `new FeedStore()` inside each handler because that would create a new instance per call).

---

## Registering a New Domain in index.ts

After creating the domain's `index.ts`, wire it into `src/index.ts` in two steps:

```typescript
// 1. Add import at the top with the other domain imports
import { registerMyDomainTools } from "./tools/my-domain/index.js";

// 2. Add registration call in the "Register tools" section
registerMyDomainTools(server);
```

That's it. Order within the registration block doesn't matter for correctness, but keep domains grouped logically.

---

## Adding a Tool to the Session Briefing

`get_session_start` is a pointer tool. It fetches no data itself - it returns a `call_these_tools` array that tells the AI agent which tools to call in parallel for a complete morning briefing. Adding a new domain to the briefing is a two-step process.

### Step 1 - Build the tool with a `render` field

Your tool returns structured data (full objects, not pre-digested summaries) plus a `render` field that encodes the four-tier rendering ladder. The agent keeps all the raw data for reasoning and uses the `render` block for presentation.

```typescript
import type { Render } from "../../types/render.js";

return {
  // Full structured data - the agent uses this to reason, prioritize, summarize
  items: [...],
  total: 5,

  render: {
    tier_1: {
      format_hint: "status_groups",  // see enum in src/types/render.ts
      instructions: {
        scope:
          "render the `items` array grouped by status; surface total as the headline.",
        format:
          "grouped list with status header chips; use the standard color conventions " +
          "for status emphasis (red overdue, amber due-today, neutral upcoming).",
        forbidden:
          "do not omit overdue items; do not summarize as prose when an artifact " +
          "tool is available; do not fall through to tier_3 when a higher tier works.",
      },
    },
    tier_3: {
      // Pre-rendered markdown fallback - clients that can't render tier 1 or 2 use this.
      markdown:
        "| Column A | Column B |\n|----------|----------|\n" +
        items.map(i => `| ${i.a} | ${i.b} |`).join("\n"),
    },
    do_not: [
      "Do not invent new color meanings; use the standard color conventions.",
    ],
  } satisfies Render,
};
```

**Why `render` matters.** Founders OS runs on different agents and clients. Some support visual primitive tools (widgets, artifacts, canvases), some render inline HTML/SVG, some only render markdown, some are plain prose. The `render` field encodes a four-tier ladder the agent self-evaluates against its own runtime: the contract reaches every client without requiring it to understand the raw data shape.

The canonical contract text lives in `packages/mcp-server/src/contract.ts` and is delivered to agents through four channels: the server `instructions` field at MCP registration, `get_session_start.rendering_contract`, the per-response `rendering_contract` reminder injected by `registerToolMap`, and the cowork plugin's CLAUDE.md (when installed). Tools just emit `render`; the delivery channels carry the agent's instructions for how to interpret it.

**Rules for `render`:**

- `tier_3.markdown` should be pre-rendered from the actual data, not a template. The agent can drop it directly into a response on tier-3 fallback.
- `tier_1.instructions` is Scope / Format / Forbidden - written as directives a literal-following model can act on without inferring. This matters specifically on stricter models like Opus 4.7.
- `format_hint` is a recipe pointer for clients that don't parse the directive. The current values are listed in `src/types/render.ts`. If you need a new one, add it to the `FormatHint` union and bump `RENDERING_CONTRACT_VERSION` in `contract.ts`. Open union with no formal versioning; the version sentinel is the drift signal.
- `do_not` carries cross-tier guardrails. Common entries: "Do not invent new color meanings; use the standard color conventions." Tools with small result sets often add: "For 2 or fewer rows, do not build a full artifact - inline rendering is fine."
- **Always mention `render` in the tool description.** Agents read the description before calling the tool and use it to frame their approach. Add a sentence like: `"Response includes a render field with tiered rendering guidance - check it before composing your reply."` This primes the agent to look for the field before it enters synthesis mode.
- `tier_2` is optional. Emit it when the agent's inline-HTML rendering would meaningfully differ from the tier-1 directive. Most tools can skip it - the ladder falls back to `tier_1.instructions` at tier 2 when omitted.

### Precedence

When `format_hint`'s default recipe disagrees with `instructions.format`, the directive in `instructions.format` wins. `format_hint` is for clients that don't parse directives (or for mechanical readers like a custom client renderer); strict-following models always read the directive.

### Step 2 - Add to the pointer

Open `src/tools/surfaces/index.ts` and add your tool name to the `call_these_tools` array in `get_session_start`:

```typescript
call_these_tools: [
  "get_task_summary",
  "get_stuck_list",
  "get_dashboard",
  "get_feed_briefing",
  "your_new_tool",       // <-- add here
],
```

That's it. The agent will call your tool alongside the others and incorporate its `render` block into the unified briefing.

### Design principles

- **Return full objects, not summaries.** The agent is better at deciding what matters than server-side code. Don't strip fields to save payload size - let the agent pick what to highlight.
- **Don't pre-write suggested actions.** Lines like "Triage 4 overdue tasks" take agency away from the AI. Return the data; let the agent synthesize.
- **Include display-ready dates.** Add `_display` suffix fields (e.g. `due_date_display: "Friday, May 15, 2026"`) alongside raw ISO dates so agents don't have to format them.
- **Each tool owns its own `render` block.** The pointer tool's `render` covers overall briefing assembly; your tool's `render` covers its own section. Don't centralize display logic.

---

## Writing tool descriptions and `render` blocks for literal-following models

Opus 4.7 and similarly strict models take instructions at face value. They will not silently generalize from one instruction to another and will not infer requests the writer didn't make. Loose phrasing pays off for older / looser models but penalizes the stricter end. The rules below help every model and help strict models in particular.

### Tool descriptions

- **No loose hedges.** Drop "if relevant," "when appropriate," "as needed," "where applicable." Replace with Scope + Condition: "Call when X. Do not call when Y."
- **Precise parameter formats.** Every `.describe(...)` should name the exact format. "YYYY-MM-DD date string," not "a date." "UUID of the customer," not "a customer ID." Strict models will not infer.
- **State what the response carries.** End the description with a sentence like `"Response includes a render field with tiered rendering guidance - check it before composing your reply."` when the tool emits `render`. Agents read descriptions before they call; this primes them to look for the field.

### `render.tier_1.instructions`

Three lines, each a directive:

- **scope** - which data fields to render and how to group them. "render the `tasks` array grouped by status." Not "render the data."
- **format** - which visual primitive to use, referencing the standard color conventions by name (defined in `COLOR_CONVENTIONS` in `contract.ts`) rather than restating them per tool. "table with phase badges and a numeric chip for open_tasks." Not "make it look nice."
- **forbidden** - what not to do. "do not display more than 20 rows by default; do not summarize the table as prose when an artifact tool is available." Forbidden directives matter most on strict models, which would otherwise interpret a permissive description as permission.

#### Sparse directives produce sparser visuals

Observed empirically during the 2026-05-19 verification runs: the more elaborate vocabulary the directive uses (visual metaphors, mechanism nouns, layered "do not" lists), the more elaborate the rendered visual tends to be. Two examples from the same `list_tasks` tool, same data, same model:

- Older directive said "render the `tasks` array as a **kanban board** grouped by status... **columns by status with task cards inside**..." The model produced a three-column layout grouped by status AND priority ("Todo - high," "Todo - medium," "In Progress") - more elaborate than the directive asked for.
- Current directive says "render the `tasks` array grouped by status... group by status, with each group visually distinct." The model produced a two-column layout grouped only by status, with priority shown as a card badge - simpler, less crowded.

The implication: writing render directives is closer to giving a designer a brief than giving a compiler a spec. Word choices nudge the model toward visual elaboration or restraint. When you want a clean compact render, use spare verbs ("group by," "show," "list") rather than evocative nouns ("kanban board," "swim lane," "card grid"). When you genuinely want elaboration, name it explicitly. The `get_feed_briefing` directive ("ranked headline list with tag badges") is the template for the restrained style.

This also matches the tone-leakage finding (`plan-render-directive-tone-cleanup.md`): cluster-vocabulary nouns leak into prose AND elaborate the visual. Terminal-vocabulary nouns do neither.

### `render.do_not`

Carries cross-tier guardrails. Two reliable defaults to include on most tools:

- `"Do not invent new color meanings; use the standard color conventions."`
- `"For 2 or fewer rows, do not build a full artifact - inline rendering is fine."` (when applicable)

The global `RENDERING_CONTRACT` text covers tier-selection rules (don't fall through when a higher tier is available, unknown `format_hint` falls through to `tier_3.markdown`); your tool's `do_not` is for tool-specific constraints on top of that.

---

## Manual test checklist (F1)

Walk this checklist against a running build before declaring a contract change shippable. Eyeball each scenario for four things:

1. Did the agent read the `render` field (or the `rendering_contract` reminder on cold-start)?
2. Did it follow `instructions.format` literally?
3. Did it pick the right rendering tier for its capabilities?
4. Did it preserve `instructions.forbidden` and `do_not` constraints?

Scenarios:

1. **Session start.** Fresh conversation, no client signals. Call `get_session_start`. Does the agent receive `rendering_contract` and apply it on the parallel briefing?
2. **Dashboard mid-conversation.** 5+ turns deep. Call `get_dashboard`. Does the agent still render `metric_cards` rather than narrate?
3. **Weekly retro with `format: "linkedin"`.** Validates the `narrative` `format_hint`. Does the agent emit the `linkedin_draft` verbatim?
4. **Partial-failure response.** Force `rename_tag` to hit `propagation_error` (rename a tag with a duplicate target). Does the agent surface the `incident` render with manual-action prominence?
5. **Conflict response.** Call `transfer_between_accounts` with a destructive action that triggers a conflict. Does the agent render `decision` chips rather than auto-picking?
6. **Long-session decay (R4), with-plugin and without-plugin.** 20-turn conversation; render-bearing tool called at turn 20. Does the agent still hit tier 1? Run both with and without the cowork plugin installed - the without-plugin run verifies the server channels carry the contract.
7. **Cold-start render (B2), with-plugin and without-plugin.** Agent enters with a direct tool call (e.g., "what's overdue") without calling `get_session_start` first. Does the per-response `rendering_contract` reminder carry the contract? Without plugin: this is the only contract delivery on the call path other than the server `instructions` field.
8. **Markdown-only client tier-3 fidelity.** Pass `client_capabilities: "markdown"` on `get_session_start`. Does the agent output `render.tier_3.markdown` verbatim or rewrite it?

This is a smell-test checklist, not a compliance report. Cross-LLM evals and automated harness work are deferred to v3.

---

## Rules for Tool Definitions

**Naming**
- Tool names: `snake_case`, verb-first (`add_customer`, `list_transactions`, `get_dashboard`)
- Title: Title Case, human-readable (`"Add Customer"`, `"List Transactions"`)

**Descriptions**
- Write for the AI, not for humans reading the source. The AI uses the description to decide when to call the tool.
- One or two sentences max. Lead with what the tool does; follow with when to call it.
- Include the specific enum values if they matter (e.g. `type: "call" | "meeting" | "email" | "note"`).

**Parameters**
- Use `z.object({...})` — not an inline shape. This is required by `registerToolMap`.
- Every parameter needs a `.describe(...)`. The AI reads these.
- Use `.optional()` for optional fields; provide sensible defaults in the handler signature.
- UUIDs: use `z.string().uuid()`.
- Dates: use `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` for YYYY-MM-DD.

**Handlers**
- Return a plain object or array. Never construct `{ content: [...] }` inside a Pattern A handler.
- Throw `new Error("Descriptive message: ${detail}")` on failure. The wrapper catches it.
- Use `Promise.all` for independent async operations.

---

## Do Not Use

- **Inline `server.registerTool()` for new domains** — it bypasses the centralized error handler and makes error behavior inconsistent.
- **Global/module-level mutable state** — use env vars or pass state through function arguments.
- **`any` types in handler signatures** — always type the destructured params explicitly.
- **MCP content envelopes in Pattern A handlers** — the wrapper builds those. Returning `{ content: [...] }` from a Pattern A handler will double-wrap the response.

---

## File Structure Reference

```
src/
  index.ts                    ← Server setup + one register*() call per domain
  supabase.ts                 ← Shared Supabase client factory
  tools/
    register.ts               ← registerToolMap() helper (detects conflict responses)
    conflict.ts               ← Conflict protocol types + helpers (import conflict() from here)
    diagnostic.ts             ← ping, get_version (direct registration, startup deps)
    meta.ts                   ← get_usage_guide (direct registration, markdown output)
    crm/
      index.ts                ← registerCRMTools() + merged ToolMap
      customers.ts            ← customerTools ToolMap
      contacts.ts             ← contactTools ToolMap
      interactions.ts         ← interactionTools ToolMap
      dashboard.ts            ← dashboardTools ToolMap
    tasks/
      index.ts                ← registerTaskTools() + taskTools ToolMap (12 tools)
    tags/
      index.ts                ← registerTagTools() + tagTools ToolMap (4 tools)
    surfaces/
      index.ts                ← registerSurfaceTools() + surfaceTools ToolMap (4 tools)
    memory/
      index.ts                ← registerMemoryTools() + memoryTools ToolMap
      embed.ts                ← embedding helper
    financial/
      index.ts                ← registerFinancialTools() + financialTools ToolMap
    rss/                      ← Pattern B (stateful FeedStore)
      index.ts                ← registerRSSTools() -- creates FeedStore, delegates to sub-registrars
      feeds.ts, items.ts, briefing.ts, store.ts, ...
```

---

## Conflict Responses

When a handler detects ambiguous input, a destructive consequence, or a
silent default that the user should know about, return a conflict instead
of guessing or throwing:

```typescript
import { conflict } from "../conflict.js";

// In the handler:
if (transferPairDetected) {
  return conflict("destructive_action", "This is part of a transfer...", [
    { key: "delete_both", label: "Delete both legs", value: { ... } },
    { key: "cancel", label: "Cancel", value: {} },
  ]);
}
```

Conflicts are NOT errors. They don't throw. They return a normal response
that the AI client presents as a choice. The operation is NOT performed
until the user decides.

The `registerToolMap` wrapper in `register.ts` automatically detects
conflict responses (via `isConflictResponse`) and skips date enrichment.
Conflicts are never returned with `isError: true`, which prevents AI
clients from retrying them in a loop.

**When to use a conflict:**

- The user could reasonably want any of the options
- The server can't know which option is correct
- The consequences of guessing wrong are significant

**When NOT to use a conflict:**

- Missing required parameters (Zod handles this)
- Invalid formats (Zod handles this)
- Permission errors (just throw)
- Cases where there's only one reasonable answer (just do it)

**Conflict types:**

- `ambiguous_input` - multiple interpretations of what user meant
- `destructive_action` - operation has irreversible consequences
- `silent_default` - server would apply a non-obvious default
- `partial_match` - lookup returned multiple candidates
- `validation_mismatch` - input contradicts itself (like date/day)

**Resolution pattern:** Handlers accept an optional parameter (e.g.
`force`, `force_mode`, `confirm`) that the AI passes on retry after the
user picks an option. When this parameter is set, the conflict check is
skipped and the operation proceeds.

See `src/tools/conflict.ts` for the full type definitions.

---

## Memory hygiene

Memories can go stale because the world changes, not because they were wrong
when written. founders-os cannot detect this on its own: the conflict is usually
between a stored memory and something outside founders-os (a Supabase project
list, git state, a file on disk). So this norm is codified as standing guidance
plus a place to record the why, not as a hard gate the server enforces.

The rule: when a recalled memory conflicts with what the agent now observes, it
should notice, investigate the cause, and resolve it - correct the memory and
tell the user when the cause can be tracked down, and ask the user only when it
cannot. When a memory does change, the reason is preserved, not just the new value.

It is codified in three places:

- **Server instructions** (`src/index.ts`, the `MEMORY:` clause) state the rule
  for every agent on every session, alongside SEARCH FIRST and the rendering
  contract.
- **`memory_recall`** returns `{ memories, count, guidance }`; the `guidance`
  string repeats the rule at the point where memories enter the agent's context.
- **`memory_update`** accepts an optional `change_reason`. For org-scoped
  memories it is written to the audit log metadata, preserving the history of why
  a shared fact changed. Personal memory changes are not audited by design, so
  `change_reason` is accepted but not persisted for them.

---

## Partial Success Responses

When an operation's primary goal succeeds but a secondary side-effect
fails, **do not throw**. Return a structured result so the AI can report
exactly what happened and what (if anything) the user needs to do
manually. Attach a `render` block with `format_hint: "incident"` so the
agent surfaces the failure rather than burying it as a quiet success.

```ts
import type { Render } from "../../types/render.js";

// Pattern: primary action succeeded, propagation failed
const incidentMarkdown =
  `**Partial success - tag rename**\n\n` +
  `The tag was renamed but propagation failed.\n\n` +
  `**Propagation error:** ${propagation_error}`;

const render: Render = {
  tier_1: {
    format_hint: "incident",
    instructions: {
      scope:
        "render as a partial-success incident. Surface that the primary " +
        "succeeded but propagation failed; quote propagation_error verbatim.",
      format:
        "incident card with an amber header per the standard color conventions; " +
        "propagation_error appears in a danger / red block beneath the success summary.",
      forbidden:
        "do not present this as a clean success; do not summarize the " +
        "propagation_error - quote it verbatim because the user needs to act on it.",
    },
  },
  tier_3: { markdown: incidentMarkdown },
  do_not: [
    "Do not invent new color meanings; use the standard color conventions.",
  ],
};

return {
  success: true,
  tag: updatedTag,
  propagation_error: "Failed to update 3 tasks: <detail>",
  tasks_updated: 12,
  tasks_failed: 3,
  render,
};
```

For multi-step failures with `manual_action_required`, the `incident` recipe is the same shape but `instructions.format` prioritizes the manual action prominently. See `tools/financial/index.ts` (`transfer_between_accounts`, `remove_transaction`) and `tools/tags/index.ts` (`rename_tag`) for live examples.

Conflict responses get their `render` block automatically via the `conflict()` helper in `tools/conflict.ts` (format_hint `"decision"`, tier_3 omitted because conflicts are interactive). You don't write the render for conflicts; the helper does it.

**When to use:**

- A write succeeded but a follow-up propagation query failed
- A multi-leg operation completed some legs but not all
- A rollback itself failed, leaving the system in a known-bad state

**When NOT to use:**

- The primary operation failed entirely (just throw)
- All steps succeeded (return normal success)
- The failure is a conflict the user should resolve first (use `conflict()`)

**Key fields:**

| Field | Purpose |
|---|---|
| `success: true` | Primary goal completed |
| `partial_failure: true` | Primary goal did NOT fully complete |
| `*_error` | Human-readable description of what failed |
| `manual_action_required` | Tells the AI what the user needs to do next |
| `render` | Incident render block with `format_hint: "incident"` |

**Examples in the codebase:**

- `rename_tag` - tag renamed in registry, but propagation to tasks/customers failed (`propagation_error`)
- `transfer_between_accounts` - outflow created, inflow failed, rollback also failed (`partial_failure`, `manual_action_required`)
- `remove_transaction` - paired transfer leg delete failed (`paired_delete_error`)
- `update_project` (tag rename path) - project record updated, tag propagation failed
