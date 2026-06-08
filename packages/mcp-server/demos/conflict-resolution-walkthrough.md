---
category: functional
---

# Conflict Resolution Protocol - Interactive Demo

> **What is this?** A guided walkthrough of how Founders OS handles uncertainty.
> Instead of silently guessing, failing with a cryptic error, or making an
> assumption, Founders OS pauses and returns a *conflict* - a structured
> question that lets your AI agent present clear options to you before anything
> changes.
>
> **Who is this for?** Anyone evaluating or onboarding to Founders OS. The demo
> creates temporary data, walks through each conflict type, then cleans
> everything up.
>
> **How to use it:** Tell your AI agent: *"Read the conflict resolution demo
> script and walk me through it."* The agent will read this file and guide
> you step by step, pausing after each scenario for you to continue.

---

## Prerequisites

- **Founders OS v0.6.0 or later.** The conflict resolution protocol was
  introduced in v0.6.0. Before starting, call `get_version` and verify the
  running version is at least 0.6.0. If it's older, tell the user they need
  to rebuild and restart the connector first.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `conflict` (run tag is `demorun-conflict-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.6.0

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Before touching any data, give the user a short orientation

Explain in 3-4 sentences:

- **What they're about to see.** Founders OS catches situations where an
  action could go wrong - like a duplicate entry, deleting something
  important, or an ambiguous request - and asks before proceeding. Instead
  of guessing or failing silently, it presents clear choices.
- **How the demo works.** You'll create some temporary sample data, then
  walk through 9 short scenarios that each trigger a different kind of
  check. After each one, you'll pause so they can ask questions or move on.
- **Cleanup.** Everything created during the demo is tagged and will be
  removed at the end. Nothing permanent.

After the verbal orientation, present a small visual previewing the kinds of
checks the demo will trigger - a simple list of the five conflict types:

1. **Duplicate catch** - Spotting a record that may already exist
2. **Smart defaults** - Asking before assuming a non-obvious setting
3. **Conflicting state** - Flagging an action that doesn't add up
4. **Destructive actions** - Warning before something irreversible
5. **Validation mismatch** - Catching a date that doesn't match its day

Don't explain each one in detail. Let the list set expectations and move on.

Keep it conversational - don't read a bulleted list. Then proceed to
creating the seed data.

### 0-seed. Create the seed data

Create the following test data. Save every returned ID for cleanup later.
Everything uses the tag `demorun-conflict-<run_id>` where tags are supported.

### 0-runid. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0a. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-conflict-<run_id>",
  description: "Ephemeral Conflict-resolution demo run tag"
}
```

Save the tag. This is the marker we use to find and clean up all demo content.

### 0b. Create a demo customer

```
Tool: add_customer
Params: {
  organization_name: "Acme Demo Corp (demo <run_id>)",
  customer_type: "client",
  customer_phase: "customer",
  tags: ["demorun-conflict-<run_id>"],
  notes: "Test customer for conflict resolution demo. Safe to delete."
}
```

Save the `customer_id`.

### 0c. Create demo tasks

**Task 1 - A blocker task (leave it incomplete):**

```
Tool: create_task
Params: {
  title: "Demo: Finalize API contract",
  scope: "org",
  status: "in_progress",
  tags: ["demorun-conflict-<run_id>"],
  description: "This task is intentionally left incomplete to demonstrate blocker conflicts."
}
```

Save as `blocker_task_id`.

**Task 2 - A dependent task (blocked by Task 1):**

```
Tool: create_task
Params: {
  title: "Demo: Ship integration to production",
  scope: "org",
  status: "blocked",
  blocked_by_task_id: <blocker_task_id>,
  tags: ["demorun-conflict-<run_id>"]
}
```

Save as `dependent_task_id`.

**Task 3 - A task with notes and a link (for destructive action demo):**

```
Tool: create_task
Params: {
  title: "Demo: Review Q2 financials",
  scope: "org",
  tags: ["demorun-conflict-<run_id>"]
}
```

Save as `rich_task_id`. Then add a note and a link:

```
Tool: add_task_note
Params: { task_id: <rich_task_id>, note: "Demo note: numbers look good" }

Tool: link_task
Params: { task_id: <rich_task_id>, entity_type: "customer", entity_id: <customer_id> }
```

### 0d. Create demo financial data

**Create a demo account:**

```
Tool: add_account
Params: { name: "Demo: Checking (demo <run_id>)", initial_balance: 10000, tags: ["demorun-conflict-<run_id>"] }
```

Save as `account_a_id`.

**Create a second demo account:**

```
Tool: add_account
Params: { name: "Demo: Savings (demo <run_id>)", initial_balance: 5000, tags: ["demorun-conflict-<run_id>"] }
```

Save as `account_b_id`.

**Look up or create a category for transfers.** List existing categories first:

```
Tool: list_categories
```

Use the existing "Transfer" category if one exists. Otherwise:

```
Tool: add_category
Params: { name: "Demo: Transfer (demo <run_id>)", type: "expense", tags: ["demorun-conflict-<run_id>"] }
```

Save as `transfer_category_id`.

**Create a transfer between the two accounts:**

```
Tool: transfer_between_accounts
Params: {
  date: "<today's date YYYY-MM-DD>",
  description: "Demo transfer for conflict walkthrough",
  amount: 500,
  from_account_id: <account_a_id>,
  to_account_id: <account_b_id>,
  category_id: <transfer_category_id>
}
```

Save the `outflow.id` as `outflow_id` and the `inflow.id` as `inflow_id`.

### 0e. Store a demo memory

```
Tool: memory_store
Params: {
  content: "Demo memory for conflict resolution walkthrough. Safe to delete.",
  project: "demorun-conflict-<run_id>",
  scope: "org"
}
```

Save as `demo_memory_id`.

### 0f. Confirm setup

Tell the user: *"Demo data is ready. I created a customer, three tasks, two
accounts with a transfer, a tag, and a memory entry - all tagged for cleanup.
Ready to start? Say 'next' to begin."*

---

## Scenario 1: Partial Match (duplicate detection)

**Conflict type:** `partial_match`
**Tool:** `add_customer`
**What the user sees:** When creating a customer with a name similar to one
that already exists, the system asks whether they meant an existing record.

### What to tell the user

> "When you add a new customer, the system checks for similar names. If it
> finds potential duplicates, it stops and asks you to choose instead of
> creating a record that might be a duplicate. Let me show you."

### Execute

```
Tool: add_customer
Params: {
  organization_name: "Acme Demo Corp (demo <run_id>)",
  customer_type: "client",
  customer_phase: "prospect"
}
```

### Expected result

A `conflict` response with type `partial_match`. The options should include:
- "Use existing: Acme Demo Corp (demo <run_id>) (customer, ...)" - pointing to the customer we created
- "Create new: Acme Demo Corp (demo <run_id>)" - with `skip_duplicate_check: true`

### What to explain after

> "See how instead of just creating a second 'Acme' record, it caught the
> similarity and gave us a choice. The AI presents these options to you
> naturally. In a real conversation, you'd just say 'use the existing one' or
> 'no, this is a new company' and the AI handles the rest."

Present the options via the interactive chooser. Whatever the user picks is
fine - if they choose an existing customer, no duplicate is created. If they
choose "Create new," a duplicate gets created; add it to the cleanup list.

**Pause here.** Wait for the user to continue.

---

## Scenario 2: Silent Defaults (non-obvious assumptions)

**Conflict type:** `silent_default`
**Tool:** `create_task`
**What the user sees:** When creating a task with a blocker set, the system
asks about the status instead of silently making it "blocked."

### What to tell the user

> "If you create a task and link it to a blocker, should the status
> automatically be 'blocked'? That seems reasonable, but maybe you want it
> 'in_progress' because you're working around the blocker. Instead of assuming,
> the system asks."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Write migration script",
  scope: "org",
  blocked_by_task_id: <blocker_task_id>,
  tags: ["demorun-conflict-<run_id>"]
}
```

Note: do NOT pass a `status` field. That's what triggers the conflict.

### Expected result

A `conflict` response with type `silent_default`. Options:
- "Yes, set status to blocked" (the default it would have assumed)
- "No, keep the default status (pending)" (let me manage status myself)
- "Cancel"

### What to explain after

> "The system caught that it was about to silently change the status to
> 'blocked' because a blocker was set. Instead of assuming, it asked. This is
> the 'validate, don't assume' principle - the server never makes non-obvious
> decisions on your behalf."

Present the options via the interactive chooser. If the user picks
"Blocked" or "To-do," retry the create with that status and add the new
task to the cleanup list. If they cancel, no task is created.

**Pause here.** Wait for the user to continue.

---

## Scenario 3: Ambiguous Input (conflicting state)

**Conflict type:** `ambiguous_input`
**Tool:** `complete_task`
**What the user sees:** Trying to complete a task whose blocker isn't done yet
raises a question about intent.

### What to tell the user

> "What should happen when you try to mark a task as complete, but the task
> it depends on isn't finished yet? Maybe the blocker is no longer relevant.
> Maybe you forgot. Instead of either blindly completing it or refusing, the
> system asks."

### Execute

```
Tool: complete_task
Params: { task_id: <dependent_task_id> }
```

### Expected result

A `conflict` response with type `ambiguous_input`. Options:
- "Complete anyway" - mark it done despite the blocker
- "Complete the blocker first" - go finish the dependency
- "Cancel"

Context should include the blocker task's ID and status.

### What to explain after

> "The system found that this task's blocker ('Finalize API contract') is still
> in progress. It didn't refuse or auto-complete - it asked what you meant.
> This is especially valuable when the AI is acting on your behalf. If you said
> 'mark my tasks done,' the AI would stop here and ask instead of silently
> completing something that shouldn't be complete yet."

**Pause here.** Wait for the user to continue.

---

## Scenario 4: Destructive Action - Task Deletion

**Conflict type:** `destructive_action`
**Tool:** `remove_task`
**What the user sees:** Deleting a task that has notes, links, or dependent
tasks triggers a safety check.

### What to tell the user

> "Deleting a task with notes, links, or other tasks depending on it is a big
> deal. The system shows you exactly what would be lost and gives you
> alternatives."

### Execute

```
Tool: remove_task
Params: { task_id: <rich_task_id> }
```

### Expected result

A `conflict` response with type `destructive_action`. Options:
- "Delete" (with `resolution: "confirm"`)
- "Archive" (with `resolution: "archive"`)
- "Complete instead" (safer alternative)
- "Cancel"

Context should mention the note count and link count.

### What to explain after

> "The system found that this task has notes and is linked to our demo
> customer. Rather than silently deleting all of that, it asked. It even
> suggested 'complete instead' as a less destructive alternative. In a real
> workflow, this prevents accidentally losing context when you say something
> like 'clean up my old tasks.'"

Present the options via the interactive chooser. Whatever the user picks,
proceed with it. If the task gets deleted or completed, note that for
cleanup. If they cancel, the task stays as-is.

**Pause here.** Wait for the user to continue.

---

## Scenario 5: Destructive Action - Transfer Deletion

**Conflict type:** `destructive_action`
**Tool:** `remove_transaction`
**What the user sees:** Deleting one leg of a transfer warns that both legs
will be removed together.

### What to tell the user

> "A transfer creates two linked transactions - money out of one account,
> money into another. If you delete just one side, the account balances go
> out of sync. The system treats the transfer as a unit."

### Execute

Use the `outflow.id` saved from setup:

```
Tool: remove_transaction
Params: { transaction_id: <outflow_id> }
```

### Expected result

A `conflict` response with type `destructive_action` offering confirm /
archive / cancel. The delete warning notes that this is one leg of a transfer
and that confirming will remove both legs together to keep the books balanced.

### What to explain after

> "The system recognized this transaction is one leg of a transfer. Confirming
> the deletion removes both legs together - there's no way to delete just one
> side, because that would throw your account balances off. This follows
> standard accounting practice, the same way QuickBooks and Xero handle it."

Present the options via the interactive chooser. If the user confirms, both
legs are deleted together - note the transfer is gone for cleanup. If they
cancel, the transfer stays.

**Pause here.** Wait for the user to continue.

---

## Scenario 6: Destructive Action - Tag with Usage

**Conflict type:** `destructive_action`
**Tool:** `remove_tag`
**What the user sees:** Deleting a tag that's in use on tasks or customers
shows the impact.

### What to tell the user

> "Tags can be used across tasks and customers. Deleting a tag from the
> registry is one thing - but should it also be removed from every entity
> that uses it?"

### Execute

`remove_tag` requires a UUID. Look up the tag's ID first:

```
Tool: list_tags
Params: {}
```

Find the entry with `name: "demorun-conflict-<run_id>"` and save its `id` as
`demo_tag_id`. Then trigger the conflict:

```
Tool: remove_tag
Params: { tag_id: <demo_tag_id> }
```

### Expected result

A `conflict` response with type `destructive_action`. Options:
- "Delete from registry AND clean from all tasks/customers"
  (`resolution: "confirm"`, `cascade: true`)
- "Delete from registry only" (`resolution: "confirm"`, `cascade: false`)
- "Cancel"

Context shows counts: how many tasks and customers use this tag.

### What to explain after

> "The system found that this tag is actively used. It gives you the choice
> between a full cleanup (remove the tag everywhere) or just removing the
> registry entry (existing items keep their tags, but the tag won't appear
> in autocomplete anymore). This matters in a team setting where removing
> a tag from someone else's tasks could cause confusion."

Present the options to the user via the interactive chooser. If the user
picks "Cancel," great - move on. If the user picks either delete option,
**go ahead and resolve it** (this is a real demo, let them see the full
flow). Then immediately re-create the tag:

```
Tool: create_tag
Params: {
  name: "demorun-conflict-<run_id>",
  description: "Ephemeral Conflict-resolution demo run tag"
}
```

Tell the user: "I re-created the tag so we can keep tracking demo data for
cleanup at the end." Re-tag any demo tasks and customers that lost it using
the tracked IDs from setup.

**Pause here.** Wait for the user to continue.

---

## Scenario 7: Destructive Action - Org Memory

**Conflict type:** `destructive_action`
**Tool:** `memory_forget`
**What the user sees:** Deleting an org-scoped memory shows a preview and asks
for confirmation.

### What to tell the user

> "Org-scoped memories are visible to the whole team. Deleting one affects
> everyone's context. The system shows you what you're about to delete."

### Execute

```
Tool: memory_forget
Params: { memory_id: <demo_memory_id> }
```

### Expected result

A `conflict` response with type `destructive_action`. Options:
- "Yes, delete this memory" (with `resolution: "confirm"`)
- "Cancel"

Context includes a preview of the memory content and when it was created.

### What to explain after

> "For personal memories, deletion just happens. For org memories, it pauses
> and shows a preview because other team members might be relying on that
> information. The AI would say something like 'This memory says: Demo
> memory for conflict resolution walkthrough. Want me to delete it?'"

**Pause here.** Wait for the user to continue.

---

## Scenario 8: Validation Mismatch (date/day conflict)

**Conflict type:** `validation_mismatch`
**Tool:** `create_task`
**What the user sees:** When a task's due date and stated day-of-week don't
match, the system asks which one is correct.

### What to tell the user

> "If someone says 'schedule this for Friday the 15th' but the 15th is
> actually a Wednesday, what should happen? The system catches the
> contradiction and asks."

### Execute

Pick a date where the day name is wrong. For example, find today's date and
use a mismatched day:

```
Tool: create_task
Params: {
  title: "Demo: Date mismatch test",
  scope: "org",
  due_date: "2026-05-11",
  due_date_day: "Friday",
  tags: ["demorun-conflict-<run_id>"]
}
```

(May 11, 2026 is a Monday, not a Friday.)

### Expected result

A `conflict` response with type `validation_mismatch`. Options:
- "Keep the date (Monday May 11)" - trust the date
- "Keep the day (Friday)" - use the nearest Friday instead
- "Cancel"

### What to explain after

> "This catches a very common mistake in natural language. A user says 'due
> Friday' but the AI parsed the date as the 11th, which is Monday. Instead
> of silently using the wrong date, the system flags it. In real usage, the
> AI would say something like 'May 11 is actually a Monday. Did you mean
> Monday the 11th or Friday the 8th?'"

Present the options via the interactive chooser. If the user picks a date
or day, retry the create with the corrected value and add the task to the
cleanup list. If they cancel, no task is created.

**Pause here.** Wait for the user to continue.

---

## Scenario 9: Silent Defaults - Tag Rename Propagation

**Conflict type:** `silent_default`
**Tool:** `rename_tag`
**What the user sees:** Renaming a tag that's used on tasks/customers asks
whether to propagate the rename.

### What to tell the user

> "One last scenario. When you rename a tag, should the old name be updated
> everywhere it's used? Maybe you just want to fix the registry entry.
> Instead of assuming, the system asks."

### Execute

First, create a temporary tag to rename:

```
Tool: create_tag
Params: { name: "demo-typo-tset-<run_id>" }
```

Then apply it to one of our demo tasks:

```
Tool: update_task
Params: { task_id: <blocker_task_id>, tags: ["demorun-conflict-<run_id>", "demo-typo-tset-<run_id>"] }
```

Now look up the tag's UUID, then rename it:

```
Tool: list_tags
Params: {}
```

Find the entry with `name: "demo-typo-tset-<run_id>"` and save its `id` as `typo_tag_id`.

```
Tool: rename_tag
Params: { tag_id: <typo_tag_id>, new_name: "demo-typo-test-<run_id>" }
```

### Expected result

A `conflict` response with type `silent_default`. Options:
- "Rename and propagate to all tasks/customers" (`propagate: true`)
- "Rename in registry only" (`propagate: false`)
- "Cancel"

### What to explain after

> "The tag was used on at least one task, so the system asked whether to
> update it everywhere. In a large project, propagation could touch hundreds
> of records, so it's worth asking first. This is also where the partial
> success pattern would kick in - if propagation to some records failed, you'd
> get a clear report of what succeeded and what didn't, instead of a cryptic
> error."

Present the options via the interactive chooser. Whatever the user picks,
proceed with it. Add any created or renamed tags to the cleanup list.

**Pause here.** Wait for the user to continue.

---

## Summary

### What to tell the user

Before cleanup, recap what the user saw in plain language. Cover the five
conflict patterns demonstrated - do NOT list internal conflict type names
or tool names. Describe each scenario by what happened:

1. Caught a possible duplicate when adding a customer
2. Automatically blocked a task that depended on another
3. Stopped completion of a task that still had blockers
4. Warned before deleting a task, transfer leg, tag, and org memory that
   had downstream effects
5. Flagged a date that didn't match the day of the week

Then tell the user:

> "That covers all five conflict types in the protocol. The key principle is
> 'validate, don't assume' - the server never makes a non-obvious decision
> without asking first. Every conflict returns structured data, not just a
> string, so the AI can present options naturally and handle the resolution
> in a follow-up call."

### Ways to ask

Present a visual reference card organized by intent. Each row has a
short intent label and 2-3 example phrases:

**When the system catches something**
- "Go with the first option"
- "Actually, keep both"
- "Cancel - don't delete it"

**Check before acting**
- "What happens if I delete this tag?"
- "Will removing that account affect anything?"
- "Is it safe to complete this task?"

**Handle duplicates**
- "That's the same customer - merge them"
- "No, those are different companies"
- "Add them as a new record anyway"

**Undo and fix**
- "That date is wrong - it should be Thursday the 15th"
- "I didn't mean to block that task"
- "Delete both sides of that transfer"

**Trust the system**
- The system asks before making non-obvious decisions
- Destructive actions always show what would be affected
- You can always cancel and nothing changes

**Pause here.** Ask: *"Ready for cleanup? I'll remove all the demo data now."*

---

## Phase 10: Cleanup

Remove all demo data in reverse order. Use the IDs saved during setup.

### 10a. Delete the demo memory

```
Tool: memory_forget
Params: { memory_id: <demo_memory_id>, resolution: "confirm" }
```

### 10b. Delete demo transactions

Delete both transfer legs:

```
Tool: remove_transaction
Params: { transaction_id: <outflow_id>, resolution: "confirm" }
```

### 10c. Delete demo tasks

Delete all three demo tasks (use `resolution: "confirm"` to skip conflicts):

```
Tool: remove_task
Params: { task_id: <rich_task_id>, resolution: "confirm" }

Tool: remove_task
Params: { task_id: <dependent_task_id>, resolution: "confirm" }

Tool: remove_task
Params: { task_id: <blocker_task_id>, resolution: "confirm" }
```

Also delete any tasks that were partially created during scenarios (unlikely
since conflicts prevent creation, but check with `list_tasks` filtered by
the run tag `demorun-conflict-<run_id>`).

### 10d. Remove demo customer

```
Tool: remove_customer
Params: { customer_id: <customer_id>, resolution: "confirm" }
```

### 10e. Delete demo tags

`remove_tag` requires a UUID. Look up all tag IDs first:

```
Tool: list_tags
Params: {}
```

For each of the three demo tags that exist (`demorun-conflict-<run_id>`,
`demo-typo-tset-<run_id>`, `demo-typo-test-<run_id>`), find its `id` and delete it:

```
Tool: remove_tag
Params: { tag_id: <demorun_conflict_tag_id>, resolution: "confirm", cascade: true }

Tool: remove_tag
Params: { tag_id: <demo_typo_tset_tag_id>, resolution: "confirm", cascade: true }

Tool: remove_tag
Params: { tag_id: <demo_typo_test_tag_id>, resolution: "confirm", cascade: true }
```

If a tag was deleted during a scenario earlier in the demo (Scenario 6),
it may not be present - skip the ones that don't appear in `list_tags`.

### 10f. Remove demo financial accounts

```
Tool: remove_account
Params: { account_id: <account_a_id>, resolution: "confirm" }

Tool: remove_account
Params: { account_id: <account_b_id>, resolution: "confirm" }
```

### 10g. Remove demo categories (if created)

If you created a "Demo: Transfer (demo <run_id>)" category during setup:

```
Tool: remove_category
Params: { category_id: <transfer_category_id>, resolution: "confirm" }
```

### 10h. Confirm cleanup

Tell the user:

> "Cleanup complete. I removed the demo memory, transfer, tasks, customer,
> tags, accounts, and categories. All the demo data is gone."

---

## Appendix: How Conflicts Work Under the Hood

For those interested in the technical details:

**Conflict structure:**

Every conflict response has this shape:

```json
{
  "conflict": {
    "type": "destructive_action | ambiguous_input | silent_default | partial_match | validation_mismatch",
    "message": "Human-readable description of the issue",
    "options": [
      {
        "key": "option_identifier",
        "label": "Human-readable option description",
        "value": { "param_to_pass_on_retry": "value" }
      }
    ],
    "ai_guidance": "Instructions for the AI on how to present this",
    "context": { "additional_data": "relevant to the decision" }
  }
}
```

**Resolution pattern:**

1. The AI calls a tool (e.g., `remove_task`)
2. The tool detects a situation that needs user input
3. Instead of acting or throwing, it returns a `conflict` response
4. The AI reads the options and presents them conversationally
5. The user picks one
6. The AI calls the same tool again, passing the resolution params from the
   chosen option's `value` (e.g., `{ resolution: "confirm" }`)
7. The tool sees the resolution param, skips the conflict check, and proceeds

**Key design decisions:**

- Conflicts are NOT errors - `isError` is never set
- Every conflict includes a cancel option
- The `ai_guidance` field tells the AI to present ALL options, not just pick one
- Options include the exact params needed for retry, so the AI doesn't need to
  reconstruct the call manually
- The server never assumes - it returns the question and lets the human decide
