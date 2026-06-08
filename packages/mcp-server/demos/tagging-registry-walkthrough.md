---
category: functional
---

# Tag Registry - Interactive Demo

> **What is this?** A guided walkthrough of how tagging works in Founders OS.
> Tags are a shared vocabulary that keeps your tasks and customers organized.
> The system helps you stay consistent by catching typos, suggesting
> conventions, and making sure nothing breaks when tags change or go away.
>
> **Who is this for?** Anyone evaluating or onboarding to Founders OS. The demo
> creates temporary data, walks through each tagging feature, then cleans
> everything up.
>
> **How to use it:** Tell your AI agent: *"Read the tagging registry demo
> script and walk me through it."* The agent will read this file and guide
> you step by step, pausing after each scenario for you to continue.

---

## Prerequisites

- **Founders OS v0.8.0 or later.** Call `get_version` and verify the running
  version is at least 0.8.0. If it's older, tell the user they need to rebuild
  and restart the connector first.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `tagging` (run tag is `demorun-tagging-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.8.0
- **No double prefixes.** When rendering a tag like `#sprint-v3` or `@Alex`,
  the prefix character is part of the tag name. If your environment uses
  icons (e.g. a hash icon for projects, an @ icon for people), show the icon
  with the bare name - not the icon next to the prefixed name. That creates
  a visual stutter like `# #sprint-v3`. Use either the icon alone (with the
  bare name) or the text with the prefix character, not both. In plain text,
  just show the prefixed name as-is.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Before touching any data, give the user a short orientation

Explain in 3-4 sentences:

- **What they're about to see.** Founders OS uses a tag registry - a shared
  list of tags that keeps everyone on the same page. When you tag a task or
  customer, the system checks your tags and offers helpful suggestions if
  something looks off. It also makes sure renaming or deleting tags doesn't
  cause problems.
- **Tag conventions (optional).** Founders OS supports three optional prefixes
  that help keep tags organized as the list grows. None of these are required -
  plain tags like "marketing" or "bug" work perfectly fine. But if you want
  extra structure, the system will gently nudge you toward them:
  - `!` for **states** - workflow stages like `!needs-review`, `!blocked`, or
    `!shipped`. Think of the exclamation mark as "attention - this is a status."
  - `@` for **people** - when you want to tag something with a person's name,
    like `@alex` or `@jordan`. The system recognizes contact names and suggests
    the prefix so people-tags stay distinct from topic-tags.
  - `#` for **projects** - registered projects like `#founders-os` or
    `#series-a`. If a project is in the registry, the system recognizes it
    by name and suggests the `#` prefix automatically. For unregistered names
    that look like projects (hyphens, version numbers), you'll get a gentler
    nudge. Simple category words pass through quietly.

  The demo will show each of these in action so you can see how the suggestions
  work.
- **How the demo works.** You'll create some sample data, then walk through
  12 short scenarios that show different tagging features. After each one,
  you'll pause so they can ask questions or move on.
- **Cleanup.** Everything created during the demo is tagged and will be removed
  at the end. Nothing permanent.

Keep it conversational - don't read a bulleted list. Then proceed to creating
the seed data.

### 0-seed. Create the seed data

Create the following test data. Save every returned ID for cleanup later.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-tagging-<run_id>",
  description: "Ephemeral Tagging demo run tag"
}
```

Save the tag ID as `tag_demo_id`. This run tag goes on every record the demo
creates, so cleanup can find exactly this run's data and nothing else.

### 0c. Create seed tags for the registry

Create four tags that represent a realistic workspace. Each tag's name (and
therefore its slug) is suffixed with the run id so it stays unique to this run:

```
Tool: create_tag
Params: { name: "Q2 2026 <run_id>", description: "Work targeting Q2 2026 quarter" }
```

Save as `tag_q2_id`.

```
Tool: create_tag
Params: { name: "Fundraising <run_id>", color: "#4A90D9", description: "Investor outreach and fundraising activities" }
```

Save as `tag_fundraising_id`.

```
Tool: create_tag
Params: { name: "Marketing <run_id>", color: "#E87B35", description: "Marketing campaigns and content" }
```

Save as `tag_marketing_id`.

```
Tool: create_tag
Params: { name: "MVP Launch <run_id>", color: "#7B68EE", description: "Tasks related to the MVP launch milestone" }
```

Save as `tag_mvp_id`.

### 0d. Register a demo project

Create a project so Scenario 8 can show registry-backed detection. The project
name is suffixed with the run id; the system derives the slug from the name, so
the auto-created `#` tag becomes run-unique too:

```
Tool: create_project
Params: {
  name: "MVP Launch <run_id>",
  description: "Demo project for tagging walkthrough. Safe to delete."
}
```

This auto-creates a `#mvp-launch-<run_id>` tag in the registry. Save the project
ID as `project_mvp_id`. Note: the "MVP Launch <run_id>" seed tag from step 0c and
this project's auto-created `#mvp-launch-<run_id>` tag share the same slug
("mvp-launch-<run_id>"), so the project will adopt the existing tag - that's fine.

### 0e. Create a demo customer

```
Tool: add_customer
Params: {
  organization_name: "Greenfield Partners (demo <run_id>)",
  customer_type: "client",
  customer_phase: "prospect",
  tags: ["demorun-tagging-<run_id>"],
  notes: "Test customer for tagging demo. Safe to delete."
}
```

Save as `customer_id`.

### 0f. Create a demo contact

```
Tool: add_contact
Params: {
  customer_id: <customer_id>,
  first_name: "Alex",
  last_name: "Chen",
  email: "alex.chen@example.com"
}
```

Save as `contact_id`.

### 0g. Create demo tasks

**Task 1 - Tagged with Q2 2026 and Marketing:**

```
Tool: create_task
Params: {
  title: "Demo: Draft launch announcement",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "Q2 2026 <run_id>", "Marketing <run_id>"],
  description: "Demo task for tagging walkthrough."
}
```

Save as `task_a_id`.

**Task 2 - Tagged with Fundraising:**

```
Tool: create_task
Params: {
  title: "Demo: Prepare investor deck",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "Fundraising <run_id>"],
  description: "Demo task for tagging walkthrough."
}
```

Save as `task_b_id`.

### 0h. Confirm setup

Tell the user: *"Demo data is ready. I created four tags, a project, a
customer, a contact, and two tasks - all tagged so they can be removed cleanly
at the end. Ready to start? Say 'next' to begin."*

---

## Scenario 1: See What Tags Exist

**Feature:** `list_tags`
**What the user sees:** The demo tags displayed visually, with a summary of
the full registry.

### What to tell the user

> "Let's start by looking at what tags are available. The tag registry is a
> shared list that everyone on your team can see. Think of it like a set of
> labels that keeps everyone using the same vocabulary."

### Execute

```
Tool: list_tags
Params: {}
```

### How to present the results

**Do not dump the raw list.** The registry may have dozens or hundreds of tags.
Instead:

1. **Visually render the 4 demo tags** as colored pill/badge elements (see
   Rendering Guidance in DEMO_RULES.md). Show each tag's
   name, color dot (if it has one), and description underneath.
2. **Summarize the rest** with a count: "...plus N other tags already in your
   workspace."
3. Then explain the key concepts conversationally:

- Each tag has a **name** (what you see) and a **slug** (the simplified version
  the system uses to match things - lowercase, hyphens instead of spaces).
- Tags can have a **color** for visual grouping and a **description** so
  everyone knows what the tag means.
- **Scope** controls visibility - "org" tags are shared, "personal" tags are
  just for you.

> "This is your team's shared vocabulary. When you tag a task or customer,
> the system checks against this list. Let's see what happens when you
> add new tags."

**Pause here.** Wait for the user to continue.

---

## Scenario 2: Create a New Tag

**Feature:** `create_tag` (including duplicate detection)
**What the user sees:** Creating a tag, then seeing what happens when you try
to create a duplicate.

### What to tell the user

> "Creating a tag adds it to the shared registry. You can give it a color and
> description so your team knows exactly what it's for. Let me create one,
> then show you what happens if someone tries to create the same tag again."

### Execute - Step 1: Create a new tag

```
Tool: create_tag
Params: {
  name: "Beta Testers <run_id>",
  color: "#2ECC71",
  description: "Customers and tasks related to beta testing"
}
```

Save as `tag_beta_id`.

### Execute - Step 2: Try to create a duplicate

```
Tool: create_tag
Params: { name: "beta testers <run_id>" }
```

### Expected result

The second call should fail with an error saying the slug "beta-testers-<run_id>"
already exists. This is because the system normalizes names to slugs -
"Beta Testers <run_id>" and "beta testers <run_id>" both become
"beta-testers-<run_id>."

### What to explain after

> "The system caught that 'beta testers' is the same tag as 'Beta Testers'
> once you strip the capitalization. This prevents your registry from filling
> up with duplicates that look slightly different but mean the same thing."

**Pause here.** Wait for the user to continue.

---

## Scenario 3: Auto-Registration

**Feature:** `validateTags` auto-registration behavior
**What the user sees:** When you use a tag on a task that isn't in the registry
yet, it gets added automatically.

### What to tell the user

> "You don't have to register every tag before using it. If you tag a task
> with something new, the system adds it to the registry for you. No extra
> steps, no interruptions."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Set up analytics dashboard",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "Onboarding <run_id>"]
}
```

Save as `task_c_id`.

### What to explain after

Check the response for the `auto_registered` field or the tag warnings. Then
call `list_tags` to show "Onboarding <run_id>" now appears in the registry.

> "See? I used the tag 'Onboarding' even though it wasn't in the registry.
> The system just added it automatically. This keeps things frictionless -
> you can tag as you go and the registry stays up to date on its own."

**Pause here.** Wait for the user to continue.

---

## Scenario 4: Typo Detection

**Feature:** `validateTags` typo warning
**What the user sees:** When you use a tag that's close to an existing one,
the system warns you.

### What to tell the user

> "What if you accidentally misspell a tag? Instead of creating a new one
> and splitting your data between two labels, the system catches it and
> asks if you meant the existing tag."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Review pitch materials",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "Fundrasing <run_id>"]
}
```

Save as `task_d_id`.

### Expected result

The task gets created (tags are soft-validated, not blocked), but the response
should include a warning with code `typo` suggesting "Fundraising <run_id>" as
the intended tag. "Fundrasing <run_id>" is also auto-registered since it wasn't
blocked. (The run-id suffix is identical on both, so the typo is just as close to
the real tag as it would be without the suffix.)

### What to explain after

> "The task was created, but the system flagged 'Fundrasing' as a possible
> typo for 'Fundraising.' It doesn't block you - maybe you really did mean
> something different - but it gives you a heads-up. In a real conversation,
> the AI would say something like 'Heads up, did you mean Fundraising?'
> and offer to fix it."

Note: If the user wants to fix it, you can update the task's tags to replace
"Fundrasing <run_id>" with "Fundraising <run_id>" and clean up the
auto-registered typo tag. Either way, track everything for cleanup.

**Pause here.** Wait for the user to continue.

---

## Scenario 5: Person Name Detection

**Feature:** `validateTags` bare_name warning (contact match)
**What the user sees:** When you use a tag that matches a known contact's name,
the system suggests using the @ prefix.

### What to tell the user

> "Founders OS has a convention for tagging people: use the @ symbol, like
> @Alex. If you tag something with a person's name but forget the @, the
> system recognizes the name and nudges you."

### Execute

```
Tool: preview_tags
Params: { tags: ["Alex"] }
```

Note: `preview_tags` is read-only - it runs exactly the validation tagging
would, but registers nothing. That is why the tag is the bare contact name
"Alex" with no run-id suffix: contact detection matches the tag's bare slug
against actual contact first/last names ("Alex Chen"), and because preview
persists nothing, there is no leftover tag to clean up later.

### Expected result

The response should include a warning with code `bare_name` saying that "Alex"
matches a known contact, and suggesting `@Alex` instead.

### What to explain after

> "The system recognized 'Alex' as a contact in your network and suggested
> using @Alex instead. The @ prefix is a convention that makes it easy to
> find everything related to a person. It's a suggestion, not a requirement -
> but it helps keep things organized as your team grows."

**Pause here.** Wait for the user to continue.

---

## Scenario 6: Customer Name Detection

**Feature:** `validateTags` bare_name warning (customer match)
**What the user sees:** When you use a tag that matches a known customer or
organization, the system suggests linking the task instead.

### What to tell the user

> "What if you tag a task with a customer's name? Tags are great for
> categories, but for customer relationships, there's a better tool -
> linking. The system knows the difference and will point you in the
> right direction."

### Execute

```
Tool: preview_tags
Params: { tags: ["Greenfield"] }
```

Note: `preview_tags` validates without persisting. Customer detection matches
the bare tag against the individual words of the customer's org name - the org
was created as "Greenfield Partners (demo <run_id>)", so the word "greenfield"
is what the system matches on. Nothing is registered, so there is nothing to
clean up.

### Expected result

The response should include a warning with code `bare_name` noting that
"Greenfield" matches a known customer/org, and suggesting `link_task` to
connect the task to the customer record instead.

### What to explain after

> "Instead of tagging with a customer name, the system suggests linking the
> task directly to the Greenfield Partners customer record. That way, when
> you pull up the customer, you see all related tasks - not just ones that
> happen to have the right tag. Tags are for categories like 'Marketing' or
> 'Q2 2026.' Relationships are for linking tasks to people and companies."

**Pause here.** Wait for the user to continue.

---

## Scenario 7: State Word Detection

**Feature:** `validateTags` missing_prefix warning (! convention)
**What the user sees:** When you use a tag that looks like a status or state,
the system suggests using the ! prefix.

### What to tell the user

> "Founders OS has another convention: the ! prefix for status tags. If you
> tag something with a word like 'blocked' or 'needs-review,' the system
> recognizes it as a state and suggests the ! prefix to keep things clear."

### Execute

```
Tool: preview_tags
Params: { tags: ["needs-review"] }
```

Note: `preview_tags` validates without persisting. State detection matches
against a fixed dictionary of state words, so the tag has to be the bare word
"needs-review" to trigger the lesson. Nothing is registered, so there is
nothing to clean up.

### Expected result

The response should include a warning with code `missing_prefix` suggesting
`!needs-review` because it looks like a state.

### What to explain after

> "The system saw 'needs-review' and recognized it as a state - something
> that describes where a task is in its lifecycle. The convention is to use
> !needs-review so it's easy to tell the difference between a category tag
> like 'Marketing' and a state tag like '!needs-review.' You can filter and
> search by these prefixes later."

**Pause here.** Wait for the user to continue.

---

## Scenario 8: Registered Project Detection

**Feature:** `validateTags` bare_name warning (project registry match)
**What the user sees:** When you use a tag that matches a registered project,
the system recognizes it and suggests the # prefix.

### What to tell the user

> "There's one more prefix convention: # for projects. Founders OS has a
> project registry - when you register a project, it gets a # tag
> automatically. If you use a project's name as a plain tag, the system
> recognizes it and suggests the # version."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Write API documentation",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "mvp-launch-<run_id>"]
}
```

Save as `task_h_id`.

### Expected result

The response should include a warning with code `bare_name` saying that
"mvp-launch-<run_id>" matches a known project, and suggesting
`#mvp-launch-<run_id>` instead. This is the registry-backed check - it matched
because we registered "MVP Launch <run_id>" as a project during setup.

### What to explain after

> "The system recognized 'mvp-launch' as a registered project and suggested
> #mvp-launch. This works the same way as contact detection with @ - if the
> project is in the registry, the match is exact. No guessing based on
> hyphens or patterns. When you create a project, it gets a # tag
> automatically."

**Pause here.** Wait for the user to continue.

---

## Scenario 9: Project Heuristic Fallback

**Feature:** `validateTags` missing_prefix warning (# heuristic for unregistered names)
**What the user sees:** When you use a tag that looks like a project name but
isn't registered, the system gives a gentler nudge.

### What to tell the user

> "What about project names that aren't registered yet? If a tag has hyphens
> or version numbers, the system gives a softer suggestion - it thinks it
> might be a project but isn't sure."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Plan beta rollout",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "beta-v2-<run_id>"]
}
```

Save as `task_h2_id`.

### Expected result

The response should include a warning with code `missing_prefix` suggesting
`#beta-v2-<run_id>` because it looks like a project name (contains a hyphen and
a version-like segment). The message is softer than Scenario 8 - it says the
tag "looks like it could be a project name" rather than stating it matches
a known project.

### What to explain after

> "Notice the difference from the last scenario. With 'mvp-launch,' the
> system was confident because the project is registered. With 'beta-v2,'
> it's making a guess based on the name pattern. If 'beta-v2' is a real
> project, you can register it and future detection will be exact. Common
> compound words like 'go-to-market' or 'follow-up' are excluded from
> this nudge so you don't get false suggestions."

**Pause here.** Wait for the user to continue.

---

## Scenario 10: Orphan Prefix

**Feature:** `validateTags` orphan_prefix warning
**What the user sees:** Using just a prefix character by itself (like "#"
with nothing after it) gets caught.

### What to tell the user

> "One quick thing - what happens if you accidentally type just a # or @
> with nothing after it? The system catches that too."

### Execute

```
Tool: create_task
Params: {
  title: "Demo: Miscellaneous cleanup",
  scope: "org",
  tags: ["demorun-tagging-<run_id>", "#"]
}
```

Save as `task_i_id`.

### Expected result

The response should include a warning with code `orphan_prefix` saying the
tag "#" is just a prefix with nothing after it.

### What to explain after

> "Simple check - a lone # or @ doesn't mean anything, so the system flags
> it. Easy to do by accident when you're typing fast."

**Pause here.** Wait for the user to continue.

---

## Scenario 11: Rename a Tag With Propagation

**Feature:** `rename_tag` with conflict resolution
**What the user sees:** Renaming a tag that's used on tasks triggers a question
about whether to update it everywhere.

### What to tell the user

> "Now let's look at what happens when a tag needs to change. Maybe you want
> to rename 'Q2 2026' to 'H1 2026' because your planning shifted. The tag
> is already used on tasks, so the system asks what you want to do."

### Execute

```
Tool: rename_tag
Params: { tag_id: <tag_q2_id>, new_name: "H1 2026 <run_id>" }
```

### Expected result

A `conflict` response with type `silent_default`. Options:
- "Yes, update everywhere" (`propagate: true`)
- "No, just rename in the registry" (`propagate: false`)

Context includes task and customer counts.

### What to explain after

> "The system found that 'Q2 2026' is used on at least one task. Instead of
> silently renaming it everywhere - or just changing the registry and leaving
> tasks out of sync - it asks. If you're just fixing a typo, you probably want
> to update everywhere. If you're retiring a tag and replacing it with a new
> one, maybe you just want the registry change."

Present the options (see Rendering Guidance) and let the user choose.
Whatever they pick, follow through. If they propagate, the tag updates on
all tasks. If not, tasks keep
"Q2 2026 <run_id>" as text but the registry entry now reads "H1 2026 <run_id>."

**Pause here.** Wait for the user to continue.

---

## Scenario 12: Delete a Tag in Use

**Feature:** `remove_tag` with conflict resolution
**What the user sees:** Deleting a tag that's used on tasks and customers
shows the impact and gives options.

### What to tell the user

> "Last scenario. What happens when you delete a tag that's in active use?
> The system shows you exactly how many items use it and gives you a choice."

### Execute

Use the Marketing tag, which is on at least one demo task:

```
Tool: remove_tag
Params: { tag_id: <tag_marketing_id> }
```

### Expected result

A `conflict` response with type `destructive_action`. Options:
- "Delete tag and remove from all items" (`resolution: "confirm", cascade: true`)
- "Delete registry entry only (items keep the tag text)"
  (`resolution: "confirm", cascade: false`)
- "Cancel"

Context shows task and customer usage counts.

### What to explain after

> "The system found that 'Marketing' is used on tasks. It gives you three
> choices: remove it everywhere (clean break), remove it from the registry
> only (items still have the tag text but it won't show up in suggestions
> anymore), or cancel. In a team setting, removing a tag from someone else's
> tasks could cause confusion, so having the option to just retire it from
> the registry is useful."

Present the options (see Rendering Guidance) and let the user choose.
Whatever they pick, proceed.
If they delete and clean, track that for cleanup. If they pick registry only,
the tasks still have the text. If they cancel, everything stays as-is.

If the user chose to delete the Marketing tag, re-create it afterward so
cleanup is consistent:

```
Tool: create_tag
Params: { name: "Marketing <run_id>", color: "#E87B35" }
```

Tell the user: "I re-created the Marketing tag so we can clean up all demo
data at the end."

**Pause here.** Wait for the user to continue.

---

## Summary

Before cleanup, recap what the demo covered:

| # | Feature | Scenario | What It Shows |
|---|---------|----------|---------------|
| 1 | Registry | List all tags | Shared vocabulary with names, colors, descriptions |
| 2 | Create | New tag + duplicate | Slug normalization prevents duplicates |
| 3 | Auto-register | Unknown tag on a task | Frictionless tagging - new tags register on the fly |
| 4 | Typo detection | Misspelled tag | Catches near-matches to existing tags |
| 5 | Person detection | Contact name as tag | Suggests @ prefix for people |
| 6 | Customer detection | Org name as tag | Suggests linking instead of tagging |
| 7 | State convention | Status word as tag | Suggests ! prefix for states |
| 8 | Project detection | Registered project as tag | Exact match from project registry suggests # prefix |
| 9 | Project heuristic | Unregistered project-like tag | Softer nudge based on name pattern (hyphens, versions) |
| 10 | Orphan prefix | Bare # with nothing after it | Catches accidental empty prefixes |
| 11 | Rename | Rename a tag in use | Asks about propagation to tasks/customers |
| 12 | Delete | Delete a tag in use | Shows impact and offers cleanup options |

Tell the user:

> "That covers the full tagging lifecycle - from creating and using tags to
> renaming and deleting them. The big ideas: tags are a shared vocabulary
> that keeps your team consistent, the system catches mistakes and suggests
> conventions without blocking you, and changes to tags are handled carefully
> so nothing breaks. The @ ! # conventions are suggestions that make
> searching easier, but they're never forced on you. And when you register
> projects, the # detection becomes exact - no guessing needed."

### Ways to ask

Present a visual reference card organized by intent. Each row has a
short intent label and 2-3 example phrases:

**Tag something**
- "Tag that task with Q2 and Fundraising"
- "Add the 'high-priority' tag to all overdue tasks"
- "What tags are on the Acme deal?"

**Browse and search by tag**
- "Show me everything tagged Fundraising"
- "What tasks have the onboarding tag?"
- "List all customers tagged enterprise"

**Create and manage tags**
- "Create a tag called Partner Deals"
- "What tags do we have?"
- "Rename 'prospects' to 'leads'"

**Use conventions**
- "Tag this with @Maya" (person)
- "Mark it !blocked" (state)
- "Add #website-redesign" (project)

**Clean up**
- "Delete the old Q1 tag"
- "What would happen if I removed the beta tag?"

**Pause here.** Ask: *"Ready for cleanup? I'll remove all the demo data now."*

---

## Phase 13: Cleanup

Remove all demo data in reverse order. Use the IDs saved during setup.

### 13a. Remove demo tasks

Remove all tasks created during the demo (pass resolution: "confirm" to skip the conflict prompt):

```
Tool: remove_task
Params: { task_id: <task_i_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_h2_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_h_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_d_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_c_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_b_id>, resolution: "confirm" }
Tool: remove_task
Params: { task_id: <task_a_id>, resolution: "confirm" }
```

Also check with `list_tasks` filtered by the `demorun-tagging-<run_id>` tag to
catch any tasks created during interactive scenarios.

### 13b. Remove demo project

```
Tool: remove_project
Params: { project_id: <project_mvp_id>, resolution: "confirm" }
```

### 13c. Remove demo customer

```
Tool: remove_customer
Params: { customer_id: <customer_id>, resolution: "confirm" }
```

### 13d. Remove demo contact

```
Tool: remove_contact
Params: { contact_id: <contact_id>, resolution: "confirm" }
```

### 13e. Remove demo tags

Remove all tags created during the demo. Pass resolution: "confirm" with cascade: true to skip the conflict and cleanly strip them from any remaining items:

```
Tool: remove_tag
Params: { tag_id: <tag_beta_id>, resolution: "confirm", cascade: true }
Tool: remove_tag
Params: { tag_id: <tag_mvp_id>, resolution: "confirm", cascade: true }
Tool: remove_tag
Params: { tag_id: <tag_marketing_id>, resolution: "confirm", cascade: true }
Tool: remove_tag
Params: { tag_id: <tag_fundraising_id>, resolution: "confirm", cascade: true }
Tool: remove_tag
Params: { tag_id: <tag_q2_id>, resolution: "confirm", cascade: true }
```

Also remove the tags that were auto-registered when scenarios applied them. The
suffixed ones - "Fundrasing <run_id>", "Onboarding <run_id>", "beta-v2-<run_id>",
"mvp-launch-<run_id>" - are unique to this run; find them with `list_tags` and
remove them by id. (Scenarios 5-7 use `preview_tags`, which registers nothing,
so there are no unsuffixed example tags to clean up.)

Finally, remove the cleanup marker tag:

```
Tool: remove_tag
Params: { tag_id: <tag_demo_id>, resolution: "confirm", cascade: true }
```

### 13f. Confirm cleanup

Tell the user:

> "Cleanup complete. I removed all the demo tasks, the project, the customer,
> the contact, and every tag we created during the walkthrough. All the demo
> data is gone."
