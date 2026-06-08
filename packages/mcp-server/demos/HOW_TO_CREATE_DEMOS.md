# How to Create a New Demo

This guide documents the conventions and patterns used across all Founders OS
interactive demos. Follow it when writing a new demo so the experience stays
consistent for users.

> **Note:** This file is repo-only. It is excluded from `dist/demos/` by the
> build script in `package.json`.

---

## File Basics

- **Location:** `packages/mcp-server/demos/`
- **Naming:** `<feature-name>-walkthrough.md` (lowercase, hyphenated)
- **Format:** Markdown, read top-to-bottom by an AI agent during the demo session
- **Shared rules:** Every demo references `DEMO_RULES.md` for presentation
  rules. Don't duplicate those rules in your demo file.

---

## Document Structure

Every demo follows this outline. Use the exact heading hierarchy shown here
so demos are scannable and predictable.

```
---
category: welcome | domain | functional
---

# <Feature Name> - Interactive Demo

> **What is this?** ...
> **Who is this for?** ...
> **How to use it:** ...

---

## Prerequisites

- **Founders OS v<X.Y.Z> or later.** ...

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** ...
(demo-specific rules here)

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. <Orientation>
### 0a. Mint the run id
### 0b. Create the run tag
### 0c-0z. <Seed steps>

---

## Scenario 1: <Title>  (or Phase 1, depending on demo style)
## Scenario 2: <Title>
...

---

## Summary

---

## Phase N: Cleanup

---

## Appendix: <Optional deep-dive> (optional)
```

### Section-by-section guidance

**Frontmatter category.** Every demo must include YAML frontmatter with a
`category` field. This controls the listing order in `list_demos`. The three
categories are:

- **`welcome`** - Onboarding/intro demos shown first. Currently only the
  welcome walkthrough uses this.
- **`domain`** - Demos tied to a specific Founders OS domain (e.g., financial
  tools, playbooks/sales). Shown after welcome.
- **`functional`** - Demos for cross-cutting features that aren't specific to
  one domain (e.g., conflict resolution, tagging). Shown last.

If you omit the category, the demo defaults to `functional`.

**Title and intro blockquote.** The blockquote at the top uses three bolded
questions: "What is this?", "Who is this for?", and "How to use it." Keep the
"How to use it" line in the format: *Tell your AI agent: "Read the [demo name]
and walk me through it."*

**Prerequisites.** State the minimum server version. Use the format:
`Founders OS v<X.Y.Z> or later.`

**How to Run This Demo.** Always start with the DEMO_RULES.md reference
line, then list only demo-specific rules. Every demo must specify:

- **Demo key:** The demo's stable key (e.g., `tagging`, `playbooks`). The run
  tag is `demorun-<demokey>-<run_id>` (see Run Isolation below). Required for all
  demos.
- **Minimum version:** Repeated here for quick reference.
- Any rules unique to this demo (e.g., external action handling, data prefix
  conventions, rendering quirks).

---

## Run Isolation (per-run tag)

Demos write to the same database and company namespace as real data, so every
run must isolate its data: a run can never collide with, or delete, another
run's (or the user's real) data. The full convention lives in `DEMO_RULES.md`
under "Run isolation"; the essentials a new demo must follow:

- **Mint a run id** in the first seed step: 8-char lowercase base36, random,
  held in context for the whole run.
- **One run tag per run:** `demorun-<demokey>-<run_id>` (reserved `demorun-`
  prefix, which nothing real uses). Create it in Phase 0, apply it to every
  fixture, delete it last in cleanup. `<demokey>` is your demo's stable key.
- **Suffix company-unique names** with ` (demo <run_id>)`: customer/org names,
  financial account and category names, and (as a slug suffix `-<run_id>`)
  playbook and project slugs. These are matched company-wide, so the suffix
  prevents two concurrent runs from colliding. Contacts, tasks, interactions,
  and transactions are not suffixed.
- **Stamp memories** with `project: "demorun-<demokey>-<run_id>"` so cleanup and
  the reaper can find them.
- **No scheduled task.** Orphans from interrupted runs are reaped server-side by
  a pg_cron job; the demo creates none (see "Safety net" below).

Special fixtures:

- **Playbook-generated tasks.** `run_playbook` inserts tasks with empty tags, so
  after running a playbook, list the generated tasks (via the customer link) and
  `update_task` each to add the run tag - otherwise the reaper cannot see them.
- **Feeds.** Feed subscriptions are per-user, shared by URL, and touch the
  user's real data. Before subscribing, check `list_feeds`; only subscribe if not
  already subscribed, and at cleanup unsubscribe only feeds this run created -
  never a pre-existing one.
- **Tags that must match real vocabulary** (a contact name, a customer-name word,
  or a state word) cannot be suffixed without breaking their lesson; baseline
  them at Phase 0 with `list_tags` and remove at cleanup only if this run created
  them.

If the demo also uses a naming prefix (like `Demo:` for financial data), that's
fine as additional clarity, but the run tag and the name suffix are what provide
isolation.

---

## Phase 0: Setup

Setup always has the same internal structure:

### 0-intro. Orientation

3-4 conversational sentences covering:

1. **What they're about to see.** The feature being demonstrated.
2. **How the demo works.** How many scenarios, what happens at each pause.
3. **Cleanup.** Reassure them everything is temporary and gets removed.

Write this as a prompt for the agent ("Explain in 3-4 sentences...") rather
than a script to read verbatim. The agent should talk naturally, not recite
bullets.

### Mint the run id (0a)

The first seed step mints the `run_id` (8-char lowercase base36, random) and
holds it in context. Every fixture and every cleanup step uses it.

### Create the run tag (0b)

Create `demorun-<demokey>-<run_id>` and save its id. This tag goes on every
record the demo creates, so cleanup finds exactly this run's data.

### Seed steps (0c, 0d...)

Letter-suffixed substeps that create all the data needed before scenarios
begin. Each step should:

- Show the exact tool call in a fenced code block
- Name the variable to save the ID as (e.g., `Save as tag_q2_id`)
- Apply the run tag, and suffix company-unique names with ` (demo <run_id>)`
- Stamp any `memory_store` with `project: "demorun-<demokey>-<run_id>"`
- Explain what the data is for if it's not obvious

### Confirm setup

End Phase 0 with a message telling the user what was created and prompting
them to say "next" to begin.

---

## Scenarios (or Phases)

Demos use either "Scenario N" or "Phase N" headings depending on the feature:

- **Scenario** style works when each step is independent and demonstrates one
  capability (e.g., conflict resolution, tagging). Scenarios are numbered
  starting at 1.
- **Phase** style works when steps build on each other sequentially (e.g.,
  financial tools where you create accounts before recording transactions).
  Phases are numbered starting at 1 (Phase 0 is always setup).

Pick whichever fits and stay consistent within the demo. Don't mix the two.

### Internal structure of a scenario/phase

Each one should include these sections:

```
## Scenario N: <Title>

**Feature:** `<tool_name>` or `<capability>`
**What the user sees:** One-line summary of the user experience.

### What to tell the user

> "Conversational explanation of what's about to happen..."

### Execute

Tool call(s) in fenced code blocks.

### Expected result

What the response should contain - conflict types, warnings, data shapes.
This helps the agent know what to look for and present.

### What to explain after

> "Conversational explanation of what just happened..."

**Pause here.** Wait for the user to continue.
```

The "What to tell the user" and "What to explain after" sections are guides
for the agent, not scripts. The agent should speak naturally using them as
a basis.

### Navigation buttons

After each scenario/phase wrap-up, place a navigation button that advances
to the next scenario. Since `sendPrompt` only works inside a widget, render
the button as a separate small widget containing only the navigation button
- not inside the main results widget. The pattern is: results widget, then
text wrap-up, then a standalone button widget calling `sendPrompt` with
the next scenario's trigger phrase. This prevents users from clicking
ahead before reading the explanation of what just happened.

For the last scenario, skip the button and instead prompt the user toward
the Summary or Cleanup phase.

---

## Tool Call Format

Use fenced code blocks with this format:

```
Tool: <tool_name>
Params: {
  key: "value",
  key2: value2
}
```

For multiple sequential calls in the same step, list them in the same block
or in separate blocks - either is fine. Use `<variable_name>` angle brackets
for values that come from earlier steps (e.g., `tag_id: <tag_q2_id>`).

Always instruct saving returned IDs:

```
Save as `customer_id`.
```

---

## Summary Section

The Summary section must come **before** the Cleanup phase, not after it.
This ensures the user sees the recap and quick reference card even if they
decide to explore on their own or leave before cleanup runs. The order is:
last scenario, then Summary (with Ways to ask), then the cleanup prompt,
then the Cleanup phase.

Two recap formats work:

**Table format** (good for demos with many short scenarios):

```
| # | What happened | What it shows |
|---|---------------|---------------|
| 1 | Caught a possible duplicate customer | System validates before creating |
```

Use plain English descriptions of what the user experienced. Never list
raw tool names, function signatures, conflict type constants, or API
identifiers in the summary table. Say "caught a duplicate" not
"`partial_match` from `add_customer`."

**Prose format** (good for sequential demos):

A few sentences recapping the workflow and key takeaways.

Follow the summary with a wrap-up quote for the agent to deliver.

### Ways to ask (required)

Every demo must include a "Ways to ask" subsection in the Summary. This
is a visual reference card that shows the user how to interact with the
feature day-to-day using natural language. Organize phrases by intent
(what the user wants to accomplish), not by tool name.

Structure: 4-6 intent groups, each with a bold label and 2-3 example
phrases. Introduce it with a line like "Here's a quick reference -
none of these are exact commands, just examples of how you can ask."

Example:

```
### Ways to ask

**Track money in and out**
- "Log a $3,000 payment from Acme Corp"
- "Record a $49 expense for Notion"
- "What transactions happened this week?"

**Check the numbers**
- "What's my financial summary?"
- "How's my P&L looking this month?"
```

The card should feel like a cheat sheet the user can scan in a few
seconds and think "oh, I can just say stuff like that." Don't explain
each phrase. Let the list speak for itself.

After the reference card, prompt the user: *"Ready for cleanup?"*

---

## Cleanup Phase

Cleanup is always the last numbered phase. It removes everything created
during setup and scenarios.

### Ordering

Delete in reverse dependency order:

1. Tasks (they reference tags and customers)
2. Projects (may reference tags)
3. Customers
4. Contacts
5. Tags (delete any example tags first, the run tag last)

There is no scheduled task to disable - orphans from interrupted runs are reaped
server-side (see "Safety net" below).

### Safety patterns

- Pass `resolution: "confirm"` to skip conflict prompts during cleanup. For
  tags, also pass `cascade: true` to strip them from items. Don't make the
  user click through confirmations for every removal.
- After deleting by saved IDs, do a sweep using the run tag (e.g., `list_tasks`
  filtered by `demorun-<demokey>-<run_id>`) to catch anything created during
  interactive scenarios. Match strictly on the run tag, never on a fixture name.
- For feeds and any tag that had to stay unsuffixed, remove only what this run
  created - never a pre-existing subscription or a same-named real tag.
- All entity types now have remove tools. Use `remove_<entity>` with
  `resolution: "confirm"` for cleanup.

### Confirm cleanup

End with a message confirming everything was removed. Don't say
"pre-demo state" or reference "before" - just confirm the demo data is gone.

---

## Safety net (server-side reaper)

Demos do not create a scheduled cleanup task, and there is no "Scheduled Cleanup
Check" section. Data from runs that end before the interactive Cleanup phase
finishes is reaped server-side: a pg_cron job (`reap-stale-demo-runs`, hourly)
hard-deletes `demorun-` fixtures older than a few hours, keyed strictly on the
reserved tag and on demo memories' `project`. A new demo gets this for free just
by following the run-tag convention - there is nothing to add to the demo file.

One gap to be aware of: the reaper does not currently reap feed subscriptions, so
feed demos depend on their guarded in-session cleanup to remove run-created
feeds.

---

## Optional Appendix

If the feature has internal mechanics worth documenting (conflict types, data
model details, design principles), put them in an appendix at the end. This
keeps the main demo flow clean while giving curious users a reference.

---

## Writing Agent-Agnostic Demos

Founders OS is open source and works with any AI agent that can call MCP
tools. Demo scripts should describe *what* to present, not *which tool* to
use for rendering. The tool-specific instructions live in `DEMO_RULES.md`'s
Rendering Guidance section, which uses conditional logic ("if you have
`AskUserQuestion`, use it; otherwise, numbered list"). This means Claude
gets explicit tool triggers while other agents get clean fallbacks.

**In demo scripts, do this:**
- "Present the options and let the user choose."
- "Show the tags visually - names, colors, and descriptions."
- "Render the result so the user can see what changed."

**In demo scripts, don't do this:**
- "Use AskUserQuestion to present the options."
- "Call show_widget to render the tags as pills."

The rendering tool names belong in `DEMO_RULES.md` (which every agent
reads), not in the individual demo scripts. If your demo has a rendering
quirk that needs environment-specific guidance, add it as a demo-specific
rule with the intent first and the conditional behavior second. See the
tagging demo's "no double prefixes" rule for an example of this pattern.

Demos no longer create any scheduling task - cleanup of interrupted runs is
handled server-side by the pg_cron reaper (see "Safety net" above), so there is
no agent-specific scheduling to abstract away.

---

## Style Checklist

Before submitting a new demo, verify:

- [ ] File is named `<feature>-walkthrough.md`
- [ ] Frontmatter includes `category: welcome | domain | functional`
- [ ] Intro blockquote has all three questions (What, Who, How)
- [ ] Prerequisites state minimum version
- [ ] "How to Run This Demo" references DEMO_RULES.md
- [ ] Demo key is specified (run tag `demorun-<demokey>-<run_id>`)
- [ ] Phase 0 has an orientation intro, a run-id mint step, the run-tag step,
      seed data steps, and setup confirmation
- [ ] Company-unique names (customers, accounts, categories, playbook/project
      slugs) are suffixed with the run id
- [ ] memory_store calls are stamped with `project: demorun-<demokey>-<run_id>`
- [ ] Every scenario/phase has: intro, tool calls, expected result, explanation,
      pause instruction
- [ ] Tool calls use the standard fenced-block format
- [ ] All created IDs are saved with named variables
- [ ] Summary section recaps what was covered in plain English
- [ ] Summary does not list raw tool names, conflict types, or API identifiers
- [ ] User-facing quotes don't contain backtick-quoted tool names or parameters
- [ ] Summary includes "Ways to ask" reference card with example phrases by intent
- [ ] Cleanup deletes everything in reverse dependency order
- [ ] Cleanup sweeps by the run tag to catch stragglers (never by name)
- [ ] Run tag is deleted last
- [ ] No scheduled task is created, and there is no "Scheduled Cleanup Check" section
- [ ] If the demo runs a playbook, generated tasks are tagged with the run tag
- [ ] If the demo subscribes to feeds, it checks before subscribing and only
      unsubscribes feeds the run created
- [ ] Navigation buttons appear after wrap-up text, not inside widgets
- [ ] No em-dashes in text (use dashes or rephrase)
- [ ] No references to "before" or "previously" - the product ships as-is
- [ ] Language is conversational, not technical jargon
- [ ] No agent-specific tool names in presentation instructions (describe
      the intent, let DEMO_RULES.md handle the rendering)
- [ ] No references to "Claude" in agent instructions - use "the agent" or
      write directly (e.g., "Explain..." not "Claude should explain...").
      Exception: `@claude` as a system assignee value in tool calls and
      narrative explaining that value are product content, not agent
      instructions - those stay as-is.
