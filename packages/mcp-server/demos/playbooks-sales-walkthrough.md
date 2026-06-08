---
category: domain
---

# Playbooks - Sales Process Demo

> **What is this?** A guided walkthrough of Founders OS Playbooks - reusable
> orchestration templates that automate the setup work every new deal requires.
> You define a playbook once, then run it against any customer to instantly
> create a full set of linked, due-date-aware tasks.
>
> This demo walks through a complete "New Deal" sales process: from first
> contact through signed contract. It shows how placeholders resolve from
> customer context, how the preflight check works, and what graceful degradation
> looks like when an external connector isn't available.
>
> **Who is this for?** Anyone evaluating or onboarding to Founders OS.
>
> **How to use it:** Tell your AI agent: *"Read the playbooks sales demo and
> walk me through it."* The agent will guide you step by step, pausing after
> each phase for you to continue.

---

## Prerequisites

- **Founders OS v0.7.0 or later.** Playbooks were introduced in v0.7.0.
  Call `get_version` at the start and confirm the running version is >= 0.7.0.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `playbooks` (run tag is `demorun-playbooks-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.7.0
- **External action handling is critical.** One step is an `external_action`
  type to demonstrate graceful degradation. When `run_playbook` returns
  `external_actions` in the response, **do NOT call any Slack, GitHub, or
  other external MCP tools** - even if they are connected in this session.
  Instead, narrate what would happen in production and manually create the
  fallback task as instructed in Phase 4. The whole point is to show the
  fallback flow, not to fire a real Slack message into the user's workspace.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Give the user a short orientation

Explain in 3-4 sentences (conversational, not a bullet list):

- **What playbooks solve.** Every new client deal has the same setup work:
  research the company, log the first contact, schedule discovery, send a
  proposal, get a contract signed. Doing this manually every time is error-prone
  and inconsistent. Playbooks let you define the process once and run it against
  any customer in seconds.
- **How this demo works.** You'll build a "New Deal" playbook step by step,
  then run it against a demo customer and watch everything get created and linked
  automatically. You'll also see the preflight check and graceful degradation
  in action.
- **Cleanup.** All demo data is tagged and removed at the end.

After the verbal orientation, present a small visual showing how the demo
unfolds - a simple numbered list of the six phases:

1. **Build** - Create the "New Deal" playbook shell
2. **Add Steps** - Lay out the sales process with placeholders
3. **Preflight** - Check what the run needs before committing
4. **Run** - Fire the playbook and watch tasks appear
5. **Inspect** - Review the created tasks and the run log
6. **Edit** - Change a step and see it affect future runs

Don't explain each one in detail. Let the list set expectations and move on.

Then proceed.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-playbooks-<run_id>",
  description: "Ephemeral Playbooks demo run tag"
}
```

Save as `tag_demo_id`. This run tag goes on every record the demo creates, so
cleanup can find exactly this run's data and nothing else.

### 0c. Create the demo customer

```
Tool: add_customer
Params: {
  organization_name: "Penrose Pottery Ltd (demo <run_id>)",
  customer_type: "prospect",
  customer_phase: "prospect",
  tags: ["demorun-playbooks-<run_id>"],
  notes: "Demo customer for playbooks walkthrough. Safe to delete."
}
```

Save as `demo_customer_id`.

### 0d. Add the primary contact

```
Tool: add_contact
Params: {
  customer_id: <demo_customer_id>,
  first_name: "Penny",
  last_name: "Penrose",
  email: "penny@penrosepottery.example.com",
  role: "Founder",
  is_primary: true
}
```

Save as `demo_contact_id`.

### 0e. Confirm setup

Tell the user: *"Demo data ready. I created a prospect called Penrose Pottery Ltd
with a primary contact, Penny Penrose (Founder). The run is tagged so it can be
removed cleanly at the end. Now let's build the playbook. Say 'next' to start."*

---

## Phase 1: Build the Playbook

### What to tell the user

> "First we create the playbook itself - just a name and a slug. Think of it
> as an empty folder. The steps come next."

### 1a. Create the playbook

```
Tool: create_playbook
Params: {
  name: "New Deal (demo <run_id>)",
  slug: "new-deal-<run_id>",
  description: "Full sales process from first contact through signed contract. Run when a new prospect enters the pipeline."
}
```

Save as `demo_playbook_id`.

### What to explain after

> "Playbook created. Now we add the steps. Each step will become a task when
> we run this against a customer - with the right assignee, due date, and
> a link back to that customer record. Let me add them."

**Pause here.** Wait for the user to continue.

---

## Phase 2: Add the Steps

### What to tell the user

> "I'm going to add 8 steps now. Notice the placeholders - things like
> `{{customer.name}}` and `{{contact.primary.name}}`. Those resolve automatically
> from the customer record when we run the playbook."

Add all 8 steps. Narrate briefly as you go, but don't pause between steps -
add them all, then pause once at the end of this phase.

### Step 1 - Research

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 1,
  type: "native_task",
  title: "Research {{customer.name}} - decision maker, priorities, recent news",
  description: "Document key findings before outreach. Check LinkedIn, their website, and any news coverage.",
  assigned_to: "user",
  due_offset: 1,
  priority: "high"
}
```

### Step 2 - Log first contact

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 2,
  type: "native_task",
  title: "Send intro message to {{contact.primary.name}} at {{customer.name}}",
  description: "Reference one specific thing from research. Keep it short. Goal: book a discovery call.",
  assigned_to: "user",
  due_offset: 2,
  priority: "high"
}
```

### Step 3 - Schedule discovery call

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 3,
  type: "native_task",
  title: "Schedule discovery call with {{contact.primary.name}}",
  description: "Aim for a 30-minute call within the first week. Use a booking link or email directly.",
  assigned_to: "user",
  due_offset: 4,
  priority: "high"
}
```

### Step 4 - Prepare discovery agenda (external_action with fallback)

This step shows what an external action looks like. It would normally post a
message to a Slack channel. Since Slack isn't connected in this demo, the
fallback_task kicks in instead. This is intentional - show the user how
graceful degradation works.

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 4,
  type: "external_action",
  title: "Notify team: new deal opened for {{customer.name}}",
  connector: "slack",
  action: "send_message",
  params: {
    channel: "#sales",
    message: "New deal opened: {{customer.name}} ({{contact.primary.name}}). Discovery call being scheduled for {{playbook.start_date+4d}}."
  },
  fallback_task: "Notify team: new deal opened for {{customer.name}} - post to #sales channel",
  due_offset: 1
}
```

### Step 5 - Prepare discovery agenda

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 5,
  type: "native_task",
  title: "Prepare discovery call agenda for {{customer.name}}",
  description: "Draft 5-7 questions covering: their current process, pain points, timeline, budget, and decision criteria.",
  assigned_to: "user",
  due_offset: 5,
  priority: "medium"
}
```

### Step 6 - Send proposal

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 6,
  type: "native_task",
  title: "Send proposal to {{contact.primary.name}}",
  description: "Scope, deliverables, timeline, and pricing. Reference specific pain points from discovery.",
  assigned_to: "user",
  due_offset: 12,
  priority: "urgent"
}
```

### Step 7 - Follow up on proposal

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 7,
  type: "native_task",
  title: "Follow up with {{contact.primary.name}} on proposal",
  description: "Check for questions, objections, or timeline updates. Ask directly: what needs to happen to move forward?",
  assigned_to: "user",
  due_offset: 16,
  priority: "high"
}
```

### Step 8 - Collect signed contract

```
Tool: add_playbook_step
Params: {
  playbook_id: <demo_playbook_id>,
  order_index: 8,
  type: "native_task",
  title: "Confirm signed contract received from {{customer.name}}",
  description: "File in clause vault. Update customer phase to 'customer'. Schedule kickoff.",
  assigned_to: "user",
  due_offset: 24,
  priority: "urgent"
}
```

### What to explain after all steps are added

> "Eight steps added. Seven are native tasks that get created directly in
> Founders OS. One is an external action - it would normally post to a Slack
> channel, but since Slack isn't connected here, it'll fall back to a native
> task. We'll see that in a moment.
>
> Notice the due offsets: day 1 for research, day 2 for intro, day 4 for
> scheduling, and so on through day 24 for the signed contract. The anchor
> date we pass when running the playbook becomes day zero - everything cascades
> from there."

**Pause here.** Wait for the user to continue.

---

## Phase 3: Preflight Check

### What to tell the user

> "Before running the playbook, let's do a preflight check. This tells us what
> connectors are needed and what the run will do - without actually executing
> anything. It's the 'are we ready?' step."

### Execute

Use today's date as start_date:

```
Tool: run_playbook
Params: {
  playbook_id: <demo_playbook_id>,
  customer_id: <demo_customer_id>,
  start_date: "<today YYYY-MM-DD>",
  preflight_only: true
}
```

### Expected result

A preflight summary with:
- `native_task_count: 7`
- `external_action_count: 1`
- `connector_requirements`: `{ connectors: ["slack"], breakdown: [...] }`
- `step_summary`: ordered list of all steps with type, connector, has_fallback

### What to explain after

> "The preflight shows us everything the playbook will do. It needs one
> connector - Slack - for the team notification step. Since that step has a
> fallback_task defined, the playbook will still run cleanly even without Slack.
> It'll just create a native task reminding us to post manually.
>
> Everything else is native - no external connectors needed. We're ready to run."

**Pause here.** Wait for the user to continue.

---

## Phase 4: Run the Playbook

### What to tell the user

> "Now the real thing. Watch what happens when we run this against Penrose Pottery Ltd."

### Execute

```
Tool: run_playbook
Params: {
  playbook_id: <demo_playbook_id>,
  customer_id: <demo_customer_id>,
  start_date: "<today YYYY-MM-DD>",
  notes: "Demo run - New Deal playbook for Penrose Pottery Ltd"
}
```

Save the returned `run_id` as `demo_run_id`.

### Expected result

- `tasks_created_count: 7` - seven native tasks created
- `external_actions_count: 1` - one Slack action emitted
- All tasks have resolved titles (no `{{placeholders}}` remaining)
- All tasks are linked to the Penrose Pottery Ltd customer record
- Due dates are calculated from today's start_date

### Handle the external action

The response includes one item in `external_actions` with connector `slack`.
Since Slack is not connected, narrate the fallback:

> "The Slack notification step came back as an external action. Since Slack
> isn't connected in this session, I'll create the fallback task instead."

Create the fallback task manually:

```
Tool: create_task
Params: {
  title: "Notify team: new deal opened for Penrose Pottery Ltd - post to #sales channel",
  due_date: "<today YYYY-MM-DD>",
  priority: "medium",
  scope: "org",
  tags: ["demorun-playbooks-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <demo_customer_id> }]
}
```

Save this task ID as `demo_fallback_task_id`.

### What to explain after

> "Eight tasks total - seven created automatically by the playbook, one created
> manually as a fallback for the Slack step. All of them are linked to Penrose Pottery Ltd.
>
> Notice the titles. 'Send intro message to Penny Penrose at Penrose Pottery Ltd.'
> 'Prepare discovery call agenda for Penrose Pottery Ltd.' The placeholders resolved
> from the customer and contact records. No copy-pasting, no manual filling in.
>
> If Slack were connected, that notification would have fired automatically
> without creating a task at all. That's the tradeoff: connected tools mean
> zero manual steps; fallback tasks make sure nothing gets lost when they're
> not."

**Pause here.** Wait for the user to continue.

---

## Phase 5: Inspect the Results

### What to tell the user

> "Let's look at the results from two angles: the task list and the run log."

### 5a. View tasks linked to the customer

```
Tool: list_entity_tasks
Params: {
  entity_type: "customer",
  entity_id: <demo_customer_id>
}
```

### Expected result

Eight tasks, all linked to Penrose Pottery Ltd, ordered by due date. Titles are
fully resolved - no placeholders visible.

### 5b. Tag the generated tasks for cleanup

The seven tasks the playbook created carry no tags of their own (`run_playbook`
inserts them with an empty tag list), so the per-run safety net cannot see them
yet. Bring them under this run's tag so both the interactive cleanup and the
server-side reaper can find them. For each task returned by step 5a, set the run
tag:

```
Tool: update_task
Params: {
  task_id: <each task id from 5a>,
  tags: ["demorun-playbooks-<run_id>"]
}
```

This is silent housekeeping - don't narrate it to the user.

### 5c. View the execution log

```
Tool: get_playbook_run
Params: { run_id: <demo_run_id> }
```

### Expected result

The run record with `execution_log` showing each step: outcome (`created` for
native tasks, `emitted` for the external action), task IDs, and due dates.

### What to explain after

> "Two ways to see what happened. list_entity_tasks shows the customer's work
> queue - everything they need from us, in order. get_playbook_run shows the
> run log - what the playbook did, step by step, with timestamps and IDs.
>
> If you run this playbook three months from now for a different customer,
> you'll have a new run log for that customer, and this one stays intact.
> Every run is independent and traceable."

**Pause here.** Wait for the user to continue.

---

## Phase 6: Edit the Playbook

### What to tell the user

> "Let's say you realize you want a step early in the process to assign a
> research task to @claude - the AI - instead of yourself. Let's update
> step 1."

### 6a. Get the step ID

Call `get_playbook` to retrieve step IDs:

```
Tool: get_playbook
Params: { playbook_id: <demo_playbook_id> }
```

Find the step with `order_index: 1` and save its `id` as `demo_step_1_id`.

### 6b. Update the step

```
Tool: update_playbook_step
Params: {
  step_id: <demo_step_1_id>,
  assigned_to: "@claude",
  description: "Research {{customer.name}} and document: decision maker, priorities, recent news, and any relevant LinkedIn activity. Store findings as a memory entry for this customer."
}
```

### What to explain after

> "Updated. From now on, every time this playbook runs, the research task
> gets assigned to @claude automatically. If you're running multiple deals,
> the AI can handle the research in parallel without blocking you.
>
> The update only affects future runs - the task already created for Penrose
> Pottery Ltd keeps its original assignee."

**Pause here.** Wait for the user to continue.

---

## Summary

Before cleanup, recap what the demo covered:

| Phase | What happened |
|-------|--------------|
| Build | Created a "New Deal" playbook with 8 steps |
| Preflight | Inspected connector requirements without executing |
| Run | 7 tasks auto-created, 1 Slack action emitted with fallback |
| Inspect | Viewed tasks linked to customer + run execution log |
| Edit | Updated a step - future runs pick up the change |

Tell the user:

> "That's the full playbook lifecycle. The key ideas:
>
> **Build once, run forever.** Define the process once and run it against any
> customer. Each run creates a fresh, linked task list from the same template.
>
> **Placeholders resolve from context.** Customer name, primary contact, start
> date, due offsets - all calculated automatically. No copy-pasting.
>
> **Preflight before you commit.** Check what connectors a playbook needs
> before running, so you know whether to expect fallbacks.
>
> **Graceful degradation.** Missing connectors create fallback tasks instead of
> failing. Nothing gets dropped."

### Ways to ask

Present a visual reference card organized by intent. Each row has a
short intent label and 2-3 example phrases:

**Build a playbook**
- "Create a playbook for onboarding new clients"
- "Add a step to the New Deal playbook"
- "Show me all my playbooks"

**Run a playbook**
- "Run the New Deal playbook for Acme Corp"
- "Kick off onboarding for this customer"
- "What would happen if I ran the sales playbook for Greenline?"

**Check on a run**
- "Show me the tasks from that playbook run"
- "What's the status on Acme's onboarding?"
- "Pull up the execution log for the last run"

**Tweak and iterate**
- "Update step 3 of the New Deal playbook"
- "Change the intro email step to a call instead"
- "Remove the Slack notification step"

**Preflight check**
- "What connectors does this playbook need?"
- "Can I run the sales playbook right now?"

Ask: *"Ready for cleanup? I'll remove all the demo data now - tasks, playbook, contact, customer, and tag - then run a verification pass to confirm nothing was left behind."*

---

## Phase 7: Cleanup

Remove all demo data in the correct order. Tasks must go before the customer
(remove_customer returns a conflict if open tasks exist). The contact and the
logged interactions are now cascade soft-deleted when you remove the customer,
so they no longer need a separate step. Always verify after each step.

**If you lost any IDs during the session**, use the tag-based fallback in 7a
to find everything before deleting.

### 7a. Find all demo tasks (tag-based fallback)

Even if you tracked all IDs, run this first as a safety net. It catches any
tasks created during scenarios that may not have been tracked:

```
Tool: list_tasks
Params: { tag: "demorun-playbooks-<run_id>" }
```

Also query by customer link to catch the playbook-created tasks (which are
linked to the customer but may not have the tag). Do NOT filter by status -
a task could be todo, in_progress, or blocked and must still be deleted:

```
Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <demo_customer_id> }
```

Combine both lists. Deduplicate by task ID. This is your full delete list.

### 7b. Remove all demo tasks

For every task ID found in 7a, plus `demo_fallback_task_id` if not already
in the list:

```
Tool: remove_task
Params: { task_id: <task_id>, resolution: "confirm" }
```

Repeat until all tasks are removed. After the last delete, verify:

```
Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <demo_customer_id> }
```

Expected result: `{ tasks: [], count: 0 }`. If any tasks remain, remove them
before continuing - `remove_customer` will conflict if open tasks exist.

### 7c. (Optional) Remove the demo contact

Removing the customer in 7d cascades to its contacts and interactions, so this
step is optional - run it only if you want the contact removal logged as its
own audit entry.

```
Tool: remove_contact
Params: { contact_id: <demo_contact_id>, resolution: "confirm" }
```

### 7d. Remove the demo customer (cascades to contacts and interactions)

`remove_customer` with resolution: "confirm" soft-deletes the customer and cascades
to its remaining contacts and all logged interactions in the same step, so
nothing is left orphaned. Tasks should already be removed from 7b:

```
Tool: remove_customer
Params: { customer_id: <demo_customer_id>, resolution: "confirm" }
```

### 7e. Remove the demo playbook

This removes the playbook and all its steps. Run history in `playbook_runs`
is preserved - it will reference a deleted playbook, which is expected and
useful for auditing.

```
Tool: remove_playbook
Params: { playbook_id: <demo_playbook_id>, resolution: "confirm" }
```

### 7f. Remove the demo tag

Use the `tag_demo_id` saved in Phase 0b. (If you lost it, call `list_tags` and
find the entry with `name: "demorun-playbooks-<run_id>"`.) Delete it and remove
it from all remaining entities:

```
Tool: remove_tag
Params: { tag_id: <tag_demo_id>, resolution: "confirm", cascade: true }
```

### 7g. Final verification pass

Run these three checks and confirm each returns clean:

```
Tool: list_tasks
Params: { tag: "demorun-playbooks-<run_id>" }
```
Expected: `{ tasks: [], count: 0 }`

```
Tool: list_customers
Params: { tag: "demorun-playbooks-<run_id>" }
```
Expected: no customers returned. Verify by tag, never by organization name -
a real customer could share the fixture's name.

```
Tool: list_playbooks
```
Expected: the `new-deal-<run_id>` slug does not appear in the list.

If anything unexpected turns up, delete it before confirming to the user.

### 7h. Confirm cleanup

Tell the user:

> "Cleanup complete. I removed all 8 playbook tasks plus the fallback task,
> removed Penny Penrose as a contact, removed Penrose Pottery Ltd, removed the
> New Deal playbook and all its steps, and removed the demo tag.
>
> The run log in playbook_runs is preserved - it references the deleted
> playbook, which is intentional and useful for auditing. Everything else
> has been removed."

---

## Appendix: How Playbooks Work Under the Hood

For those interested in the technical details:

**The three tables:**

- `playbooks` - named templates (name, slug, description)
- `playbook_steps` - ordered steps with type, title, placeholders, connector info, fallback
- `playbook_runs` - execution log per customer run

**Placeholder resolution:**

All text fields in steps support `{{placeholder}}` syntax. At run time,
`run_playbook` resolves these from the customer record, the primary contact,
and the start_date parameter. The resolution is recursive - it handles nested
JSON in `params` fields for external actions.

**External action contract:**

Founders OS does not call external APIs directly. It emits structured action
definitions in the `external_actions` array. The AI agent reads these and
dispatches them using whatever MCP tools are connected. This keeps Founders OS
lean and connector-agnostic.

**Connector availability:**

Founders OS cannot query which MCP tools are connected to the client session.
Use `preflight_only: true` to inspect requirements before running. At execution
time, if a connector is unavailable, create a native task using the step's
`fallback_task` field.

**Run status:**

- `running` - set immediately on creation
- `complete` - all steps processed successfully (external actions emitted is not an error)
- `partial` - one or more native task creation steps errored
