---
category: domain
---

# CRM Walkthrough - Interactive Demo

> **What is this?** A guided walkthrough of all the CRM tools in Founders OS.
> The demo follows a realistic scenario: a promising new company reaches out,
> and you need to get them into your pipeline fast. You will watch the whole
> lifecycle play out - searching before adding, building up the contact record,
> logging real interactions, creating linked follow-up tasks, advancing the
> pipeline phase, and pulling up a full entity view so nothing falls through
> the cracks.
>
> **Who is this for?** Anyone evaluating or onboarding to Founders OS who wants
> to see the CRM in action with real data.
>
> **How to use it:** Tell your AI agent: *"Read the CRM walkthrough demo and
> walk me through it."* The agent will guide you step by step, pausing after
> each phase for you to continue.

---

## Prerequisites

- **Founders OS v0.5.0 or later.** All CRM tools used here were available
  as of v0.5.0. Call `get_version` at the start and confirm the running
  version meets this minimum.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `crm` (run tag is `demorun-crm-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.5.0
- **Build progressively.** Unlike some demos that seed all data upfront,
  this one creates the customer, contacts, interactions, and tasks during the
  phases themselves. Phase 0 only creates the cleanup tag. This way the user
  watches the full onboarding workflow from scratch.
- **Interactions cascade on cleanup.** Interactions are durable touchpoint
  history but can be soft-deleted with `remove_interaction`, and deleting a
  customer cascades to all of its interactions in the same step. During
  cleanup, removing the demo customer leaves nothing orphaned.
- **Render created items visually.** After every tool call that creates or
  updates data, show the resulting record as a concrete visual element using
  the item-list or callout-card patterns from DEMO_RULES.md. Do not just
  mention it in text.

---

## Phase 0: Setup

### 0-intro. Give the user a short orientation

Explain in 3-4 sentences (conversational, not a bullet list):

- **What they are about to see.** The full CRM workflow for bringing a new
  company into the pipeline: from first search through a live opportunity with
  contacts, interactions, and linked tasks.
- **How this demo works.** It builds one record from scratch across several
  short phases. Each phase covers one capability. They watch and can jump in
  at any point.
- **Cleanup.** Everything created during the demo is tagged and removed at the
  end. Removing the demo customer also clears its contacts and interactions, so
  nothing is left behind. The separate audit log keeps an immutable record of
  what happened, by design.

After the verbal orientation, present a small visual showing how the workflow
unfolds - a simple numbered list of the six phases:

1. **Search & Add** - Check for duplicates, then add the company
2. **Contacts** - Add the people inside the company
3. **Interactions** - Log the calls and emails
4. **Linked Task** - Create follow-up work tied to the record
5. **Pipeline** - Advance them from prospect to opportunity
6. **Full Picture** - Pull the entity card and the dashboard

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
  name: "demorun-crm-<run_id>",
  description: "Ephemeral CRM demo run tag"
}
```

Save as `tag_demo_id`. This run tag goes on every record the demo creates, so
cleanup can find exactly this run's data and nothing else.

### 0c. Confirm setup

Tell the user: *"Setup done. I created the cleanup tag so this run's data can
be removed cleanly at the end. Now let's bring in a new customer. Say 'next'
to begin."*

---

## Phase 1: Search First, Then Add the Customer

**What the user sees:** The search-before-creating protocol in action, followed
by adding Lumio Labs as a new prospect.

### What to tell the user

> "The first rule in Founders OS CRM: always search before you add. Let me
> show you why. A company called Lumio Labs just reached out. Before I
> create anything, I search first to make sure we don't duplicate them."

### 1a. Search for the customer

```
Tool: search_customers
Params: { query: "Lumio Labs" }
```

### Expected result

Either no results (clean) or an existing Lumio Labs record from prior use.
If an existing record is found, explain to the user that this is the real
record and you will create a separate tagged demo version alongside it so
cleanup stays safe. If no results, proceed directly.

### 1b. Add the customer

```
Tool: add_customer
Params: {
  organization_name: "Lumio Labs (demo <run_id>)",
  customer_type: "prospect",
  customer_phase: "prospect",
  website: "https://lumiolabs.example.com",
  notes: "Inbound inquiry via the website contact form. Early-stage conversation about strategy consulting retainer.",
  tags: ["demorun-crm-<run_id>"]
}
```

Save the returned `id` as `demo_customer_id`.

### Expected result

A new customer record with `customer_type: "prospect"` and
`customer_phase: "prospect"`. The `tags` field should include
`demorun-crm-<run_id>`.

### What to explain after

> "Lumio Labs is in the pipeline as a prospect. The tag ties this record to
> our demo cleanup so nothing is left behind. Notice the search step we did
> first. That is the right habit. Founders OS does not block you from creating
> a duplicate, but searching first catches the mistake before it happens."

Render the created customer record as a visual card showing: organization name,
type badge, phase badge, website, and notes.

**Pause here.** Wait for the user to continue.

---

## Phase 2: Add Contacts

**What the user sees:** Adding a primary contact and a second contact to the
same customer record.

### What to tell the user

> "Customers are organizations. Contacts are the people inside them. Let me
> add the two people we will be working with at Lumio Labs."

### 2a. Add the primary contact

```
Tool: add_contact
Params: {
  customer_id: <demo_customer_id>,
  first_name: "Stacy",
  last_name: "Beaker",
  email: "stacy@lumiolabs.example.com",
  role: "CEO",
  is_primary: true
}
```

Save the returned `id` as `demo_contact_primary_id`.

### 2b. Add a second contact

```
Tool: add_contact
Params: {
  customer_id: <demo_customer_id>,
  first_name: "Alex",
  last_name: "Kim",
  email: "alex@lumiolabs.example.com",
  role: "Head of Strategy",
  is_primary: false
}
```

Save the returned `id` as `demo_contact_secondary_id`.

### Expected result

Two contacts linked to the Lumio Labs record. Stacy Beaker is marked primary.

### What to explain after

> "Two contacts, one organization. Stacy is the primary - he will show up
> prominently in the entity card view and is the person playbooks reference
> by default when they need a name. Alex is secondary, still fully accessible
> but not the default point of contact.
>
> You can have as many contacts as you need per organization. And if a contact
> moves to a different company later, you just update their record rather than
> losing the history."

Render both contacts as a visual list showing: name, role, email, and primary
status badge.

**Pause here.** Wait for the user to continue.

---

## Phase 3: Log Interactions

**What the user sees:** Logging an email and a discovery call against the
Lumio Labs record, and why this history matters.

### What to tell the user

> "Every conversation with a customer should be logged. Founders OS tracks
> four types: email, call, meeting, and note. Let me log two touchpoints with
> Lumio Labs that happened this week."

### 3a. Log the intro email

```
Tool: log_interaction
Params: {
  customer_id: <demo_customer_id>,
  interaction_type: "email",
  subject: "Intro email - retainer model and discovery call",
  body: "Sent intro email to Stacy following up on the website inquiry. Outlined our retainer model and suggested a 30-minute discovery call.",
  interaction_date: "<today YYYY-MM-DD>T09:00:00Z"
}
```

### 3b. Log the discovery call

```
Tool: log_interaction
Params: {
  customer_id: <demo_customer_id>,
  interaction_type: "call",
  subject: "Discovery call - timeline and priorities",
  body: "30-minute discovery call with Stacy and Alex. They are evaluating two other vendors. Decision timeline is 3 weeks. Key priorities: async-first workflow, clear deliverables per sprint. Agreed to send a proposal by end of week.",
  interaction_date: "<today YYYY-MM-DD>T14:30:00Z"
}
```

### Expected result

Two interaction records attached to the Lumio Labs customer, with timestamps
and summaries.

### What to explain after

> "Two touchpoints logged. A few things to notice:
>
> First, interactions stick around. Your call log is durable history you want
> intact even if the deal falls through. You can remove a mistaken entry, but
> touchpoints persist by default - and the immutable record of what happened
> lives in the separate audit log.
>
> Second, the notes from that call are actually useful business context. We
> know the decision timeline is 3 weeks and the two things they care most
> about. That context comes back up every time we pull the entity card."

Render both interactions as a visual list showing: type icon, date, and
summary excerpt.

**Pause here.** Wait for the user to continue.

---

## Phase 4: Create a Linked Task

**What the user sees:** A task created and linked directly to the Lumio Labs
customer record, so it shows up in the entity card and the daily task view.

### What to tell the user

> "The discovery call surfaced a clear next step: send a proposal by end of
> week. Let me create a task for that and link it back to Lumio Labs so it
> never gets lost in a generic to-do list."

### Execute

```
Tool: create_task
Params: {
  title: "Send proposal to Lumio Labs - retainer model, async-first workflow focus",
  due_date: "<Friday of the current week YYYY-MM-DD>",
  priority: "high",
  scope: "org",
  assigned_to: "sales",
  tags: ["demorun-crm-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <demo_customer_id> }]
}
```

Save the returned task `id` as `demo_task_id`.

### Expected result

A task linked to Lumio Labs, due Friday, assigned to sales, tagged with this
run's tag (`demorun-crm-<run_id>`).

### What to explain after

> "Task created and linked. This task now appears in the entity card for
> Lumio Labs alongside the contact records and interaction history. It also
> shows up in the normal task view filtered by the demo tag, and in the
> stuck list if it goes overdue.
>
> The link is the key piece. Instead of a floating task that you eventually
> forget which deal it belonged to, this one is attached to the customer
> record. Anyone on the team pulling up Lumio Labs sees it immediately."

Render the task as a visual card showing: title, due date, priority badge,
assignee, and the Lumio Labs link.

**Pause here.** Wait for the user to continue.

---

## Phase 5: Advance the Pipeline

**What the user sees:** Moving Lumio Labs from prospect to lead to
opportunity as the deal develops, and how the phase change reflects in the
record.

### What to tell the user

> "The discovery call went well. We know their timeline and priorities.
> Lumio Labs has moved beyond a cold inquiry. Let me advance them through
> the pipeline."

### 5a. Move to lead

```
Tool: update_customer
Params: {
  customer_id: <demo_customer_id>,
  customer_type: "lead",
  customer_phase: "lead"
}
```

### 5b. Move to opportunity

```
Tool: update_customer
Params: {
  customer_id: <demo_customer_id>,
  customer_type: "opportunity",
  customer_phase: "opportunity",
  notes: "Inbound inquiry via website. Discovery call completed. Proposal due end of week. Competing against 2 other vendors. Decision in 3 weeks. Key fit: async-first workflow, sprint deliverables."
}
```

### Expected result

Customer record updated with `customer_type: "opportunity"` and
`customer_phase: "opportunity"`. Notes updated with enriched context from the
discovery call.

### What to explain after

> "Lumio Labs is now an opportunity. The pipeline phases are: prospect,
> lead, opportunity, customer, renewal. After renewal comes either more
> renewal or churn. The customer_type and customer_phase fields both update
> so the dashboard counts stay correct.
>
> We also enriched the notes with context from the discovery call. That is
> the right habit. Notes in the customer record are visible to everyone on
> the team without them having to dig through the interaction log."

Render the updated customer record as a card showing the new type, phase, and
notes.

**Pause here.** Wait for the user to continue.

---

## Phase 6: The Full Picture

**What the user sees:** The entity card for Lumio Labs, which bundles the
customer record, contacts, interactions, and linked tasks in a single call.
Then the CRM dashboard for a pipeline-wide view.

### What to tell the user

> "Now let me show you the two most useful read views: the entity card for a
> single customer, and the dashboard for the whole pipeline."

### 6a. Pull the entity card

```
Tool: get_entity_card
Params: {
  entity_type: "customer",
  entity_id: <demo_customer_id>
}
```

### Expected result

A combined response containing:
- Customer record (Lumio Labs, opportunity phase, website, notes)
- Contacts: Stacy Beaker (primary) and Alex Kim
- Recent interactions: the email and the discovery call
- Open tasks: the proposal task

### 6b. Pull the CRM dashboard

```
Tool: get_dashboard
Params: { days: 7 }
```

### Expected result

A pipeline summary showing counts by phase, including Lumio Labs in the
opportunity bucket. Also shows upcoming tasks within the 7-day window and any
recent interactions.

### What to explain after

> "Two views, two different jobs.
>
> The entity card is your go-to before any conversation or meeting. One call
> gives you the full picture: who the contacts are, what you have discussed,
> and what is still open. No tab-switching.
>
> The dashboard is your morning check-in. How many prospects, leads,
> opportunities? What tasks are due this week? Which customers have been quiet
> too long? These are the questions that keep a pipeline healthy."

Render the entity card result as a structured visual showing all four sections
(record, contacts, interactions, tasks). Render the dashboard as a metric
grid for pipeline counts.

**Pause here.** Wait for the user to continue.

---

## Summary

Recap what the demo covered before moving to cleanup:

| Phase | What happened |
|-------|---------------|
| Search and add | Searched first, then added Lumio Labs as a new prospect |
| Contacts | Added a primary contact (Stacy) and a secondary contact (Alex) |
| Interactions | Logged an intro email and a discovery call with full context |
| Linked task | Created a proposal task tied directly to the customer record |
| Pipeline | Advanced from prospect to lead to opportunity |
| Full picture | Pulled the entity card and the CRM dashboard |

Tell the user:

> "That is the core CRM workflow. A few things to carry forward:
>
> **Search before you add.** The one habit that keeps your pipeline clean.
>
> **Customers and contacts are separate records.** Organizations change.
> People move. Keeping them separate means the history stays intact either way.
>
> **Interactions are durable history.** Log every touchpoint. That history is
> there when you need it, especially for deals that come back months later.
>
> **Link tasks to customers.** A task without context is just noise. A task
> linked to a customer is actionable."

### Ways to ask

Present a visual reference card organized by intent. Here are the groups:

**Add a new company and contacts**
- "Add Acme Corp as a new prospect"
- "Add Sarah Chen as the primary contact at Acme - she is the CTO"
- "Does Acme already exist in the CRM?"

**Log what happened**
- "Log a call with Lumio Labs - we discussed pricing and they want a proposal by Friday"
- "Note that Alex went quiet after the proposal - add that to their record"
- "Record a meeting with Stacy at Lumio Labs, 45 minutes, covered onboarding timeline"

**Track follow-up work**
- "Create a task: send proposal to Acme, due Friday, high priority, link it to Acme"
- "What tasks are linked to Lumio Labs?"
- "Show me everything open for this customer"

**Move them through the pipeline**
- "Move Lumio Labs from prospect to lead"
- "Update Acme's phase to opportunity"
- "Mark Greenline as churned with a note"

**See the full picture**
- "Give me everything on Lumio Labs" (entity card)
- "What is going on with Acme Corp?"
- "Show me the CRM dashboard"
- "Which customers have gone quiet in the last 30 days?"

Ask: *"Ready for cleanup? I will remove all the demo data now - the task, contacts, customer record, and tag - and run a verification pass to confirm nothing is left behind."*

---

## Phase 7: Cleanup

Remove all demo data in the correct order. Tasks must go before contacts and
the customer, since remove_customer returns a conflict if open tasks remain.

**If you lost any IDs during the session**, use the tag-based fallback in 7a
to find everything before deleting.

### 7a. Find all demo tasks (tag-based sweep)

Even if you tracked all IDs, run this first to catch any tasks created during
interactive steps that may not have been saved:

```
Tool: list_tasks
Params: { tag: "demorun-crm-<run_id>" }
```

Also query by customer link to catch any tasks linked to the customer but not
tagged:

```
Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <demo_customer_id> }
```

Combine both lists and deduplicate by task ID. This is the full delete list.

### 7b. Remove all demo tasks

For every task ID found in 7a, including `demo_task_id`:

```
Tool: remove_task
Params: { task_id: <task_id>, resolution: "confirm" }
```

After the last delete, verify:

```
Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <demo_customer_id> }
```

Expected result: `{ tasks: [], count: 0 }`. If any remain, remove them before
continuing - remove_customer will conflict if open tasks exist.

### 7c. Remove the demo customer (cascades to contacts and interactions)

Deleting the customer with `resolution: "confirm"` now cascades: both contacts
(Stacy and Alex) and all logged interactions are soft-deleted in the same
step, so nothing is left orphaned. Recoverable for 30 days, then purged.

```
Tool: remove_customer
Params: { customer_id: <demo_customer_id>, resolution: "confirm" }
```

If you want each contact removal logged as its own audit entry, you can still
delete the contacts explicitly with `remove_contact` before this step - but
it is optional now that the cascade handles them.

### 7d. Remove the demo tag

Delete the run tag and remove it from all remaining entities:

```
Tool: remove_tag
Params: { tag_id: <tag_demo_id>, resolution: "confirm", cascade: true }
```

### 7e. Final verification pass

Run these checks and confirm each returns clean:

```
Tool: list_tasks
Params: { tag: "demorun-crm-<run_id>" }
```

Expected: `{ tasks: [], count: 0 }`

```
Tool: list_customers
Params: { tag: "demorun-crm-<run_id>" }
```

Expected: no customers returned. Verify by tag, never by organization name -
a real customer could share the fixture's name.

```
Tool: list_tags
Params: {}
```

Expected: `demorun-crm-<run_id>` does not appear in the list.

If anything tagged `demorun-crm-<run_id>` turns up, remove it before confirming
to the user.

### 7f. Confirm cleanup

Tell the user:

> "Cleanup complete. I removed the proposal task, both contacts (Stacy and Alex),
> the Lumio Labs demo customer record, its logged interactions, and the
> demo tag.
>
> Deleting the customer cascaded to its contacts and interactions in the same
> step, so nothing is left orphaned. All of it is recoverable for 30 days, then
> permanently purged. The immutable record of what happened lives in the audit
> log, which is separate from the CRM interaction history."

---

## Appendix: CRM Data Model

For those who want to understand how the pieces fit together:

**Three core tables:**
- `customers` - organizations with type, phase, website, notes, and tags
- `contacts` - people linked to a customer, with role and is_primary flag
- `interactions` - log of touchpoints (email, call, meeting, note); soft-deletable, and cascades when its customer is deleted

**Pipeline phases vs. customer types:**
Both `customer_type` and `customer_phase` should be updated together when
advancing a deal. The `customer_type` is the classification (what kind of
relationship this is), and `customer_phase` is where they are in the lifecycle.
They share the same vocabulary intentionally.

**How interaction removal works:**
Interactions are durable touchpoint history, but not immortal. An individual
interaction can be soft-deleted with `remove_interaction` (recoverable for 30
days), and deleting a customer cascades to all of its interactions in the same
step. The immutable record of what happened lives in the separate audit log,
not in the CRM interaction history - so removing a mistaken interaction never
creates a gap in the audit trail. If you'd rather preserve the touchpoint, add
a corrective note instead of deleting it.

**Search protocol:**
`search_customers` does a fuzzy text search across organization names and notes.
`search_contacts` searches across person names and emails. Never use
`search_customers` to find a person. Always use `search_contacts` for that.

**Entity card vs. get_customer:**
`get_entity_card` is the right call when you need everything about a customer
before a meeting or decision. `get_customer` is more efficient when you only
need CRM fields (contacts list, phase) and do not need the open task or
interaction summary.
