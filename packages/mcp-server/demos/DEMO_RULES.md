# Demo Presentation Rules

These are the shared rules for running any Founders OS interactive demo.
Every demo script in this directory references this file. Individual demos
may add demo-specific rules on top of these.

The rules are agent-agnostic where possible. The **Rendering Guidance**
section at the end tells you exactly which tools to use when they're
available, with fallbacks for environments that don't have them.

---

## Rules

When a user asks you to run a demo, follow these rules:

1. **Check the version first.** Call `get_version` and confirm the running
   version meets the minimum stated in the demo's Prerequisites section.
   If the version is too old, stop and explain.

2. **Read the entire demo document first** before starting any steps.

3. **Create all seed data in the Setup phase** before running any scenarios.

4. **Pause after each scenario (or phase).** Explain what happened, then wait
   for the user to say "next", "continue", or similar before proceeding.

5. **Track all created IDs** in a running list so cleanup can find everything.

6. **Tag everything** with the demo's designated tag (stated in each script)
   so cleanup is reliable.

7. **If the user says "quit", "stop", or "done"** at any point, skip directly
   to the Cleanup phase. Do not leave demo data behind.

8. **Speak naturally.** Don't read the markdown verbatim - use the scenario
   descriptions as a guide. Explain what's about to happen, execute it, then
   explain what the user just saw.

9. **Present results, don't dump data.** When a conflict, warning, or notable
   result comes back, present it in a way the user can act on - see
   Rendering Guidance below for exactly how. Never show raw JSON unless the
   user asks. Let the user experience the flow first, then briefly explain
   what happened and why it matters.

10. **Let the user choose freely.** Don't steer the user toward any particular
    option. Whatever they pick, follow through and adjust cleanup accordingly.
    If a choice removes something needed later, re-create it and explain why.

11. **Keep language simple.** Users may not be technical. Describe what the
    system does, not how it works internally. No references to "before" or
    "previously" - this is the product as it ships.

12. **Narrate, then show.** Before each tool call, tell the user what you're
    about to do and why: "Let me create a task tagged 'Onboarding' and we'll
    see what happens." Then execute the call, present the result visually (see
    Rendering Guidance below), and add a brief explanation of what the user
    just saw. The pattern is: narrate the action, show the result, explain
    the takeaway. If a result set is large (e.g. 50+ items), show only the
    relevant demo items and summarize the rest with a count. **Show, don't
    tell:** when an action creates something (a task, a customer, a
    transaction), render the created item as a concrete visual element -
    title, assignee, due date, linked entity, etc. Don't just mention it
    in text or a badge. The user should see exactly what the system produced.

13. **Navigation buttons after wrap-up.** After each scene, place a "next
    scene" button after the main results widget and wrap-up commentary -
    not inside the results widget. This prevents users from clicking
    ahead before reading the explanation. Since `sendPrompt` only works
    inside a widget, render the button as a separate small widget
    containing only the navigation button. The pattern is: results
    widget, then text wrap-up, then a standalone button widget. Example:
    after explaining Scene 1's results, render a small widget with a
    button like "Next: new lead comes in" that calls `sendPrompt` with
    Scene 2's trigger phrase.

14. **Orient the user before diving in.** Each demo has a "0-intro" setup
    step. Use it to explain in 3-4 conversational sentences what they're
    about to see, how the demo works, and that everything gets cleaned up at
    the end. Don't read a bulleted list - just talk.

15. **No external tools unless the demo explicitly says otherwise.** Demos
    are self-contained inside Founders OS. Do not call Slack, calendar,
    GitHub, or other MCP connectors unless the demo script specifically
    instructs it. If a demo includes external-action steps, follow that
    demo's specific rules for how to handle them.

16. **Never show raw tool names in summaries.** The summary at the end of a
    demo should describe what the user accomplished in plain English, not
    list internal tool names, function signatures, conflict type constants,
    or API identifiers. Say "we recorded transactions and ran a P&L report"
    not "`add_transaction` records entries, `get_pl_report` generates
    reports." If the demo script contains a tool-name table in its Summary
    section, replace it with a conversational recap of what happened. The
    "Ways to ask" reference card is the right ending - natural phrases
    organized by intent.

---

## Rendering Guidance

Use the best presentation tools available in your environment. Check for
each tool below and use the first option that applies.

### Presenting choices (conflicts, options, confirmations)

If you have `AskUserQuestion`, **use it** - present options as clickable
buttons so the user can pick without typing. This is the preferred approach.

Otherwise, present options as a numbered list and ask the user to reply
with a number:

```
The system found a conflict. What would you like to do?

1. Update the tag everywhere
2. Just rename it in the registry
3. Cancel

Reply with a number to choose.
```

### Presenting data (tags, tasks, results, summaries)

If you have `show_widget`, **use it** - render results as visual elements:
tags as colored pills/badges, warnings as callout cards with icons, lists
as formatted tables or cards. For large result sets (50+ items), render
only the relevant demo items visually and summarize the rest with a count.

When rendering widgets, never hardcode hex colors for text or backgrounds.
Always use CSS variables (`var(--color-text-primary)`,
`var(--color-background-info)`, etc.) so output is readable in both light
and dark themes. Hardcoded colors like `#EEEDFE` or `#534AB7` will break
in one mode or the other.

If you don't have `show_widget` but can render markdown, use bold for
labels, tables for structured data, and code blocks for identifiers.

If you have no formatting support, use indentation and clear labels. One
item per line.

### Visual patterns (for `show_widget` environments)

When rendering widgets, reuse these patterns so every demo looks and feels
the same. Don't invent new layouts for data types that already have a
pattern here.

**Setup summary (Phase 0 confirmation).** A grid of metric-style cards,
one per created item. Each card has a muted icon + label on top and the
item name in medium weight below, with an optional subtitle line for role
or detail. Use `background: var(--color-background-secondary)` with no
border. Grid: `repeat(auto-fit, minmax(160px, 1fr))`, gap 12px.

**Item list (tasks, steps, tags, transactions).** Vertical stack with no
card wrapper. Each row is a flex container: a numbered or icon circle on
the left, the item name in the middle, and a right-aligned detail (date,
priority badge, or status). Rows are separated by
`border-bottom: 0.5px solid var(--color-border-tertiary)` except the last
row. Consistent font size: 14px for the name, 12px for details.

- Priority badges: `font-size: 11px; padding: 2px 6px; border-radius:
  var(--border-radius-md)`. Use `--color-background-danger` / `text-danger`
  for high and urgent, `--color-background-secondary` / `text-secondary`
  for medium, and `--color-background-info` / `text-info` for low.
- Status badges: same sizing. Use `--color-background-success` /
  `text-success` for complete/created, `--color-background-warning` /
  `text-warning` for emitted/fallback/pending.

**Execution log.** Same vertical stack as an item list, but each row uses
a status icon on the left (check icon for created, send icon for emitted,
alert icon for error), a step label in the middle, and the timestamp or
outcome on the right. Always include timestamps when the data provides
them - don't mention timestamps in narration if the widget doesn't show
them.

**Side-by-side comparison.** A two-column grid
(`grid-template-columns: 1fr 1fr`, gap 16px) of raised cards. Each card
has `background: var(--color-background-primary)`,
`border: 0.5px solid var(--color-border-tertiary)`,
`border-radius: var(--border-radius-lg)`, padding `1rem 1.25rem`. Use a
muted header with icon inside each card. Internal content follows the
item list pattern.

**Callout card (warnings, conflicts, notable results).** A single raised
card (same border/radius as comparison cards) with a colored left border
accent: `border-left: 3px solid var(--color-border-warning)` for warnings,
`--color-border-danger` for errors, `--color-border-info` for
informational. No border-radius on the left edge. Icon + bold label on top,
description below.

**Reference card (quick-reference phrases, "Ways to ask" cards).** A single
widget with a header line and grouped rows. Start with a header:
"Quick reference - just say it however feels natural" (16px, weight 500,
`--color-text-primary`, `margin-bottom: 1rem`). Then each group has a bold
intent label (14px, weight 500, `--color-text-primary`) followed by 2-3
example phrases (13px, `--color-text-secondary`) as plain text lines with
a left-aligned dash or bullet. Groups are separated by
`margin-bottom: 1rem`. Wrap the whole card in
`background: var(--color-background-secondary)`,
`border-radius: var(--border-radius-lg)`, padding `1.25rem 1.5rem`. No
border, no raised card style - keep it flat and scannable. The user should
be able to read it in a few seconds like a cheat sheet. Present 4-6
groups. Don't use a table layout - a simple stacked list with clear
groupings reads faster.

**General rules across all patterns:**

- Never mention data in narration that the widget doesn't actually show.
  If you say "with timestamps," timestamps must be visible.
- Numbered circles: `min-width: 24px; height: 24px; border-radius: 50%;
  font-size: 12px; font-weight: 500`. Use `--color-background-info` /
  `text-info` for standard items, `--color-background-warning` /
  `text-warning` for items that need attention.
- All text uses CSS variables, never hardcoded colors.
- Truncate long text with `white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis` and set `min-width: 0` on the flex child.
- Keep widgets compact. Padding on the outer container: `1rem 0` (top and
  bottom only, no horizontal - the host provides side padding).

---

## Run isolation

Demos write to the same database and company namespace as real data, so every
run must be self-contained: a run can never read, collide with, or delete
another run's data, whether two people run concurrently or the same demo runs
twice in a row. Each demo follows this convention.

**Run id.** At the start of Phase 0, mint a `run_id`: 8 characters, lowercase
base36 (`0-9a-z`), random (for example `k3p9zq4m`). Hold it in context for the
whole run, alongside the IDs you track for cleanup.

**Run tag.** Create one tag per run and put it on every fixture:

```
demorun-<demokey>-<run_id>
```

`demorun-` is a reserved prefix owned by the demo system; nothing real ever uses
it. `<demokey>` is the demo's stable key, stated in each script (for example
`welcome`). This per-run tag replaces any fixed per-demo tag.

**Fixture names.** Suffix every fixture whose name or slug is unique per company
with the run id, for example `Greenline Studio (demo k3p9zq4m)`. This covers
customer and organization names, financial account and category names, playbook
slugs, and project slugs - any of which would otherwise collide between two
concurrent runs. Contacts, interactions, tasks, and transactions are not
suffixed (they belong to a suffixed parent or have no company-wide unique name).
In narration you may use the clean base name; the stored record carries the
suffix.

**Cleanup.** Key every cleanup sweep to the exact run tag. Because the tag is
unique to this run, a sweep can only ever match this run's fixtures. Match
strictly on the tag, never on a fixture name - a name-based sweep in an earlier
demo once deleted a real `OurThinkTank` customer that resembled a demo fixture.

**No scheduled task.** Demos do not create any scheduled cleanup task. Data from
runs that end before the interactive Cleanup phase finishes is reaped
server-side by the database: a pg_cron job (`reap-stale-demo-runs`, hourly)
hard-deletes `demorun-` fixtures older than a few hours, matching strictly on the
reserved tag and on demo memories' `project`. There is nothing for the agent to
set up, and it runs whether or not any app is open.
