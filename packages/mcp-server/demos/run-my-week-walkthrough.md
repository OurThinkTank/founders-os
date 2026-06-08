---
category: domain
---

# Run My Week - Interactive Demo

> **What is this?** The full Founders OS experience in one session. Instead of
> showing a single feature, this demo follows a founder through a compressed
> week - from Monday morning check-in through Friday retro. You'll watch CRM,
> tasks, finance, feeds, playbooks, and memory work together as one connected
> system. Everything created during the demo is cleaned up at the end.
>
> **Who is this for?** Anyone who has seen the basics and wants to understand
> what it actually feels like to run a business through Founders OS. Also great
> as a first demo for people who want the full picture up front.
>
> **How to use it:** Tell your AI agent: *"Read the Run My Week demo and walk
> me through it."* The agent will guide you step by step, pausing along the way
> for you to continue.

---

## Prerequisites

- **Founders OS v0.12.0 or later.** Scene 3 attributes a payment directly to a
  customer via the `customer_id` parameter on `add_transaction`, which requires
  v0.12.0. Call `get_version` at the start and confirm the running version is
  >= 0.12.0. If it's older, stop and explain.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** plus these
demo-specific rules:

- **Demo key:** `run-my-week` (run tag is `demorun-run-my-week-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.12.0
- **This demo has two modes.** Scenes 1-4 are agent-led: the agent narrates
  and executes while the user watches. Scenes 5-6 are user-led: the agent
  asks the user to make choices and then carries them out. Make the transition
  feel natural.
- **Hide the tool names.** This demo targets founders who want to see the
  system work, not learn API calls. Never say "I'm going to call
  get_session_start" or "using the add_customer tool." Describe the action
  in plain language: "Let's check in on your week" or "Let's add them to
  your pipeline."
- **This is a story, not a feature tour.** Each scene should flow naturally
  into the next. The thread connecting everything is: a founder starts their
  week, handles what comes up, and closes it out by reflecting on what they
  accomplished. Don't break the narrative to explain architecture.
- **Show the connections.** The whole point of this demo is that actions in
  one domain show up in another. When a playbook creates tasks, point out
  that those tasks appear in the morning check-in. When a payment is logged,
  show it on the entity card alongside CRM data. Make the cross-domain
  links explicit.
- **No external tools.** This demo is entirely self-contained inside
  Founders OS. Do not call Slack, calendar, GitHub, or other connectors.
- **Keep widgets varied.** This demo touches many domains, so use different
  visual patterns for each - don't show the same card layout six times.
  The setup summary, entity card, stuck list, and retro should each feel
  distinct.
- **Day headers.** Each scene has a **Day label** field (e.g., MONDAY,
  TUESDAY). Render this prominently at the top of each scene's widget -
  large, uppercase, no date underneath. The week is fictional and
  compressed, so real dates would break the illusion. Just the day name
  sells the progression.
- **Navigation buttons after wrap-up.** Place the "next scene" button
  after the main results widget and wrap-up commentary, not inside the
  results widget itself. This prevents users from clicking ahead before
  reading the explanation of what just happened. Render the button as a
  separate small widget containing only a `sendPrompt` button that
  triggers the next scene. The pattern is: results widget, then text
  wrap-up, then a standalone button widget.
- **Show, don't tell.** When an action creates something - a task, a
  customer, a transaction, a bookmark - show the created item as a
  concrete visual element in the widget (title, assignee, due date,
  linked entity, etc.). Don't just mention it in a badge or describe it
  in text. The user should see exactly what the system produced. This
  is what makes outputs feel real instead of abstract.
- **Live network calls for feeds.** RSS feeds require fetching from the
  internet. If a feed URL fails, acknowledge it naturally and move on.
  The demo works even if feeds are down - it just skips the feed-related
  parts of Scenes 1 and 4.

---

## The Story

Here's the narrative that ties everything together. The agent should
internalize this and narrate naturally - not read it to the user verbatim.

It's the start of a new week. You sit down Monday morning and ask your AI
assistant to catch you up. The system pulls together everything that matters -
tasks, pipeline, finances, news - in one shot.

During the week, a new lead comes in: Northstar Robotics reached out after
seeing your work with another client. You capture them, run your sales
playbook, and watch eight tasks appear automatically. Meanwhile, an existing
client - Meridian Health - sends a payment, so you log it and move money to
your tax reserve.

You spot an article in your feeds that's relevant to the Northstar deal, so
you bookmark it and create a follow-up task. Mid-week, you triage what's
stuck. By Friday, you run a retro to see what you accomplished, store a key
decision in memory, and pull up the full picture on your new client.

That's the thread. One week, six scenes, every domain.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Welcome the user

Explain in 3-4 conversational sentences:

- **What they're about to see.** A full week with Founders OS - morning
  check-in, capturing a new lead, logging payments, reading industry news,
  triaging what's stuck, and closing out the week with a retro. Everything
  working together.
- **How the demo works.** Six scenes. The first four are agent-led, the
  last two are hands-on. The whole thing takes about 10 minutes.
- **Cleanup.** Everything created is temporary and gets removed at the end.

After the verbal orientation, present a small visual showing how the week
unfolds. A simple timeline or numbered list of the six scenes:

1. **Monday AM** - Check in on everything at once
2. **New Lead** - A prospect reaches out, playbook kicks in
3. **Money Moves** - Log a payment, set aside taxes
4. **Feed Insight** - Spot something useful, link it to the deal
5. **Triage** - Clear the stuck list (your turn)
6. **Friday Retro** - What got done, what to remember (your turn)

Don't explain each one in detail. Let the list set expectations and move on.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-run-my-week-<run_id>",
  description: "Ephemeral Run-my-week demo run tag"
}
```

Save as `tag_demo_id`. This run tag goes on every record the demo creates, so
cleanup can find exactly this run's data and nothing else.

### 0c. Create the existing client - Meridian Health

This is the client who's been around for a while. They represent the "real
business" context that makes the demo feel grounded.

```
Tool: add_customer
Params: {
  organization_name: "Meridian Health (demo <run_id>)",
  customer_type: "client",
  customer_phase: "customer",
  tags: ["demorun-run-my-week-<run_id>"],
  notes: "Digital health platform. Engaged us for mobile UX work in March. Active project with strong relationship."
}
```

Save as `customer_meridian_id`.

### 0d. Add the Meridian contact

```
Tool: add_contact
Params: {
  customer_id: <customer_meridian_id>,
  first_name: "Jordan",
  last_name: "Park",
  role: "VP Product",
  email: "jordan.park@meridianhealth.example.com",
  is_primary: true
}
```

Save as `contact_jordan_id`.

### 0e. Log a past interaction with Meridian

```
Tool: log_interaction
Params: {
  customer_id: <customer_meridian_id>,
  contact_id: <contact_jordan_id>,
  interaction_type: "call",
  subject: "Project check-in - mobile redesign progress",
  body: "Reviewed sprint progress on the mobile patient portal. Jordan is happy with the direction. They mentioned a second phase for the clinician dashboard. Invoice for Phase 1 coming this week."
}
```

Save as `interaction_meridian_id`.

### 0f. Set up financial accounts

```
Tool: add_account
Params: {
  name: "Demo: Main Checking (demo <run_id>)",
  initial_balance: 8400,
  tags: ["demorun-run-my-week-<run_id>"]
}
```

Save as `checking_id`.

```
Tool: add_account
Params: {
  name: "Demo: Tax Reserve (demo <run_id>)",
  initial_balance: 2100,
  tags: ["demorun-run-my-week-<run_id>"]
}
```

Save as `tax_reserve_id`.

### 0g. Create financial categories

Check for existing categories first with `list_categories`. If income and
expense categories already exist, use them. Otherwise create demo versions:

```
Tool: add_category
Params: { name: "Demo: Client Revenue (demo <run_id>)", type: "income", tags: ["demorun-run-my-week-<run_id>"] }
```

Save as `cat_revenue_id`.

```
Tool: add_category
Params: { name: "Demo: Software Tools (demo <run_id>)", type: "expense", tags: ["demorun-run-my-week-<run_id>"] }
```

Save as `cat_software_id`.

```
Tool: add_category
Params: { name: "Demo: Transfer (demo <run_id>)", type: "expense", tags: ["demorun-run-my-week-<run_id>"] }
```

Save as `cat_transfer_id`.

### 0h. Record a prior expense (to make financials feel real)

```
Tool: add_transaction
Params: {
  date: "<7 days ago YYYY-MM-DD>",
  description: "Linear Team Plan - monthly",
  amount: 32,
  category_id: <cat_software_id>,
  account_id: <checking_id>,
  tags: ["demorun-run-my-week-<run_id>"]
}
```

Save as `tx_prior_id`.

### 0i. Create existing tasks (mix of statuses)

These make the morning check-in and stuck list feel populated.

**Task 1 - Overdue and stuck:**

```
Tool: create_task
Params: {
  title: "Demo: Send revised scope to Meridian Health",
  priority: "high",
  due_date: "<3 days ago YYYY-MM-DD>",
  status: "in_progress",
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_meridian_id> }]
}
```

Save as `task_overdue_id`.

**Task 2 - Due this week:**

```
Tool: create_task
Params: {
  title: "Demo: Draft case study from Meridian Phase 1",
  priority: "medium",
  due_date: "<3 days from now YYYY-MM-DD>",
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_meridian_id> }]
}
```

Save as `task_casestudy_id`.

**Task 3 - Blocked:**

```
Tool: create_task
Params: {
  title: "Demo: Schedule Phase 2 kickoff with Jordan",
  priority: "high",
  status: "blocked",
  blocked_by_task_id: <task_overdue_id>,
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_meridian_id> }]
}
```

Save as `task_blocked_id`.

**Task 4 - Recently completed (for retro):**

```
Tool: create_task
Params: {
  title: "Demo: Deliver mobile wireframes to Meridian",
  priority: "high",
  status: "completed",
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_meridian_id> }]
}
```

Save as `task_done_id`.

### 0j. Store a seed memory

```
Tool: memory_store
Params: {
  content: "Meridian Health prefers async updates over meetings. Jordan Park likes short Loom videos for progress demos. Billing is net-30.",
  scope: "org",
  project: "demorun-run-my-week-<run_id>",
  source_tool: "demo"
}
```

Save as `memory_meridian_id`.

### 0k. Subscribe to a demo feed (guarded - touches the user's real feeds)

Feed subscriptions belong to the real user, not to this run, so handle them
carefully. First, list the user's current subscriptions and check whether they
already follow this URL:

```
Tool: list_feeds
Params: {}
```

Look for an entry whose `url` is `https://hnrss.org/frontpage`.

- **If the user is ALREADY subscribed:** do NOT subscribe again
  (`subscribe_feed` would fail with "Already subscribed to this feed.") and do
  NOT plan to unsubscribe it at cleanup - it is the user's real feed. Save its
  existing feed id as `feed_hn_id`, set `feed_created_by_run = false`, and move on.
- **If the user is NOT subscribed:** subscribe now, tagging the feed with this
  run's tag so it is recognizable as run-created:

```
Tool: subscribe_feed
Params: {
  url: "https://hnrss.org/frontpage",
  tags: ["tech", "demorun-run-my-week-<run_id>"],
  pinned: true
}
```

Save the returned feed id as `feed_hn_id` and set `feed_created_by_run = true`.
If the subscribe fails because it was already subscribed (race), treat it as the
already-subscribed case: capture the existing id via `list_feeds` and set
`feed_created_by_run = false`.

### 0l. Create the sales playbook

This playbook will be used in Scene 2. Build it now so Scene 2 can focus
on the run, not the setup.

```
Tool: create_playbook
Params: {
  name: "New Deal (demo <run_id>)",
  slug: "new-deal-demo-<run_id>",
  description: "Sales process from first contact through signed contract. Run when a new prospect enters the pipeline."
}
```

Save as `playbook_id`.

Add 6 steps (a streamlined version for the demo):

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 1,
  type: "native_task",
  title: "Research {{customer.name}} - decision maker, recent news, competitors",
  description: "Document key findings before outreach.",
  assigned_to: "@claude",
  due_offset: 1,
  priority: "high"
}
```

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 2,
  type: "native_task",
  title: "Send intro message to {{contact.primary.name}} at {{customer.name}}",
  description: "Reference one specific thing from research. Keep it short. Goal: book a discovery call.",
  assigned_to: "user",
  due_offset: 2,
  priority: "high"
}
```

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 3,
  type: "native_task",
  title: "Schedule discovery call with {{contact.primary.name}}",
  description: "30-minute call within the first week. Use a booking link or email directly.",
  assigned_to: "user",
  due_offset: 4,
  priority: "high"
}
```

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 4,
  type: "native_task",
  title: "Prepare discovery agenda for {{customer.name}}",
  description: "Draft 5-7 questions covering their current process, pain points, timeline, and budget.",
  assigned_to: "user",
  due_offset: 5,
  priority: "medium"
}
```

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 5,
  type: "native_task",
  title: "Send proposal to {{contact.primary.name}}",
  description: "Scope, deliverables, timeline, and pricing.",
  assigned_to: "user",
  due_offset: 12,
  priority: "urgent"
}
```

```
Tool: add_playbook_step
Params: {
  playbook_id: <playbook_id>,
  order_index: 6,
  type: "native_task",
  title: "Follow up with {{contact.primary.name}} on proposal",
  description: "Check for questions, objections, or timeline updates.",
  assigned_to: "user",
  due_offset: 16,
  priority: "high"
}
```

### 0m. Confirm setup

Present a visual summary of everything created - the customer, contact,
accounts, tasks, playbook, feed, and memory. Use a setup summary grid
showing each item category and count. Then tell the user the stage is set:

> "Your workspace is loaded. You've got a client with history, a few tasks
> in different states, financial accounts, a news feed, and a sales playbook
> ready to go. Say 'next' to start your Monday morning."

**Pause here.**

---

## Scene 1: Monday Morning - "Catch me up"

**Day label:** MONDAY
**What the user sees:** One question pulls together tasks, pipeline, finances,
and feeds into a single morning briefing.

### What to tell the user

> "It's Monday morning. You just sat down with your coffee and you want to
> know where things stand. In Founders OS, you just say 'catch me up' and
> the system pulls together everything - tasks, pipeline, finances, news -
> in one shot. Let me show you."

### Execute

```
Tool: get_session_start
Params: {}
```

Then pull the morning feed briefing:

```
Tool: get_feed_briefing
Params: { max_headlines: 4 }
```

These can run in parallel.

### Expected result

The session start returns a cross-domain summary: task counts by status,
overdue items, CRM pipeline activity, financial pulse, and suggested
actions. The feed briefing returns top headlines from pinned feeds.

### What to explain after

Present the results as a unified morning dashboard with the MONDAY day
header prominent at the top. Render it as a multi-section visual - not
separate widgets. The user should see tasks, pipeline, money, and news
in one view.

Walk through each section in plain language:

- "Here's your task snapshot - you've got one overdue item and one blocked."
- "Your pipeline has one active client."
- "Financially, here's where your accounts stand."
- "And here are today's top headlines from your feeds."

Point out the overdue task specifically:

> "See that overdue task? 'Send revised scope to Meridian Health' - that's
> been sitting for three days. We'll deal with that later in triage. For
> now, notice that one question gave you the full picture across your whole
> business. No switching between apps, no checking five different dashboards."

If feeds failed to load, skip the feed section naturally: "Your news feeds
are quiet right now" and move on.

**Pause here.**

---

## Scene 2: A New Lead - "Someone just reached out"

**Day label:** TUESDAY
**What the user sees:** A new prospect enters the pipeline. A playbook runs
against them and six tasks materialize instantly, all linked and dated.

### What to tell the user

> "While you were reviewing your morning, an email came in. The CTO of a
> robotics startup called Northstar Robotics saw your work with Meridian
> Health and wants to talk about a project. Let's capture them and get
> the sales process moving."

### Execute

Step 1 - Add the prospect:

```
Tool: add_customer
Params: {
  organization_name: "Northstar Robotics (demo <run_id>)",
  customer_type: "client",
  customer_phase: "prospect",
  website: "https://northstarrobotics.example.com",
  notes: "Inbound lead via email. CTO saw our Meridian Health work. Interested in UX for their operator dashboard.",
  tags: ["demorun-run-my-week-<run_id>"]
}
```

Save as `customer_northstar_id`.

Step 2 - Add the contact:

```
Tool: add_contact
Params: {
  customer_id: <customer_northstar_id>,
  first_name: "Priya",
  last_name: "Sharma",
  role: "CTO",
  email: "priya@northstarrobotics.example.com",
  is_primary: true
}
```

Save as `contact_priya_id`.

Step 3 - Log the interaction:

```
Tool: log_interaction
Params: {
  customer_id: <customer_northstar_id>,
  contact_id: <contact_priya_id>,
  interaction_type: "email",
  subject: "Inbound inquiry - operator dashboard UX",
  body: "Priya reached out after seeing our Meridian Health case study. Their team is building an operator dashboard for warehouse robots and needs UX help. Timeline: wants to start in 3-4 weeks."
}
```

Save as `interaction_northstar_id`.

Step 4 - Run the sales playbook:

> "Now here's where it gets interesting. Instead of manually creating a
> bunch of follow-up tasks, let's run the sales playbook against Northstar.
> Watch what happens."

```
Tool: run_playbook
Params: {
  playbook_id: <playbook_id>,
  customer_id: <customer_northstar_id>,
  start_date: "<today YYYY-MM-DD>",
  notes: "Inbound lead from Priya Sharma, CTO. Interested in operator dashboard UX."
}
```

Save the returned `run_id` as `run_northstar_id`.

Step 5 - Tag all playbook-created tasks for cleanup:

The playbook engine inserts the generated tasks with an empty tag list, so the
per-run tag sweep and the server-side reaper cannot see them yet. Bring them
under this run's tag. List the tasks the run just created by following the
customer link, then set the run tag on each:

```
Tool: list_entity_tasks
Params: {
  entity_type: "customer",
  entity_id: <customer_northstar_id>
}
```

For each task returned, set the run tag:

```
Tool: update_task
Params: {
  task_id: <each task id from the list above>,
  tags: ["demorun-run-my-week-<run_id>"]
}
```

This is silent housekeeping - don't narrate it to the user. The updates can run
in parallel.

### Expected result

Six tasks created automatically, all linked to Northstar Robotics. Titles
have resolved placeholders - "Send intro message to Priya Sharma at Northstar
Robotics." Due dates cascade from today. The first task (research) is
assigned to @claude. All tasks carry the `demorun-run-my-week-<run_id>` tag for
reliable cleanup.

### What to explain after

Present the results with the TUESDAY day header at the top.

Show the six created tasks as a visual timeline - task title, assignee,
due date, and priority. Highlight the resolved placeholders:

> "Six tasks, created in seconds. Notice the titles - 'Send intro message
> to Priya Sharma at Northstar Robotics.' The playbook pulled the contact
> name and company name from the record you just created. No copy-pasting."

Then point out the @claude assignment:

> "And see that first task? 'Research Northstar Robotics' - that's assigned
> to @claude, the AI. It can start working on that research right now while
> you handle other things. When you check in tomorrow, the research will
> be waiting for you."

Now show the entity card to demonstrate the full picture:

```
Tool: get_entity_card
Params: {
  entity_type: "customer",
  entity_id: <customer_northstar_id>
}
```

Present the entity card visually:

> "Here's the full picture on Northstar. One customer record, one contact,
> the inbound email logged, and six tasks all linked and scheduled. Five
> minutes ago this prospect didn't exist. Now there's a complete sales
> process in motion."

**Pause here.**

---

## Scene 3: Money Moves - "Meridian just paid"

**Day label:** WEDNESDAY
**What the user sees:** A payment logged, taxes set aside, and the financial
picture updated - all connected to the customer record.

### What to tell the user

> "Good news from the Meridian Health side - Jordan just sent the Phase 1
> payment. Let's log it and set aside the tax reserve."

### Execute

Step 1 - Record the payment:

```
Tool: add_transaction
Params: {
  date: "<today YYYY-MM-DD>",
  description: "Meridian Health - Phase 1 mobile redesign (Invoice #2044)",
  amount: 6800,
  category_id: <cat_revenue_id>,
  account_id: <checking_id>,
  customer_id: <customer_meridian_id>,
  tags: ["demorun-run-my-week-<run_id>"]
}
```

Save as `tx_meridian_id`. Passing `customer_id` at creation time attributes the
payment directly to Meridian Health, so it shows up on their entity card without
any task-link bookkeeping.

Step 2 - Transfer 25% to tax reserve:

> "You set aside 25% of every client payment for taxes. That's $1,700
> moving to the reserve."

```
Tool: transfer_between_accounts
Params: {
  date: "<today YYYY-MM-DD>",
  description: "Tax reserve - 25% of Meridian Phase 1 ($6,800)",
  amount: 1700,
  from_account_id: <checking_id>,
  to_account_id: <tax_reserve_id>,
  category_id: <cat_transfer_id>
}
```

Save as `transfer_out_id` and `transfer_in_id`.

Step 3 - Show the financial picture:

```
Tool: get_financial_summary
Params: { timezone: "America/Chicago" }
```

### Expected result

The financial summary shows updated totals across both accounts. The payment
increased checking, the transfer moved money to tax reserve. Year-to-date
figures reflect the new income.

### What to explain after

Present the financial summary with the WEDNESDAY day header at the top.
Show account balances, YTD income, YTD expenses, net.

> "Payment logged, taxes set aside, and your financial picture is up to date.
> The transfer created two linked entries - money out of checking, money into
> tax reserve - and neither one shows up on your P&L because it's just moving
> money between your own accounts."

Now show how this connects back to the customer:

```
Tool: get_entity_card
Params: {
  entity_type: "customer",
  entity_id: <customer_meridian_id>
}
```

> "And look at Meridian's entity card. The Phase 1 payment is right there
> under linked transactions, sitting alongside their tasks, interactions,
> and contact info - all because you tagged the payment to Meridian when
> you logged it. One view, everything about this client. That's the
> connection - finance isn't off in a separate tool. It's part of the
> same picture."

**Pause here.**

---

## Scene 4: Feed Insight - "This is relevant"

**Day label:** THURSDAY
**What the user sees:** A news article connects to an active deal. The user
bookmarks it and creates a linked task.

### What to tell the user

> "While you're between tasks, let's check if anything interesting showed
> up in your feeds. Sometimes an article is directly relevant to a deal
> you're working on."

### Execute

Step 1 - Pull recent headlines:

```
Tool: get_feed_items
Params: {
  feed_id: <feed_hn_id>,
  limit: 5
}
```

If feeds fail or return empty, skip to a fallback version of this scene
(described below).

### Expected result

A list of recent headlines from the subscribed feed.

### What to explain after (with feed results)

Present the headlines with the THURSDAY day header at the top. Then pick
the most relevant-sounding article
(anything related to technology, robotics, UX, or startups works well):

> "See that article? That could be useful context for the Northstar deal.
> Let's bookmark it so you don't lose it, and create a task to reference
> it in the discovery call."

Step 2 - Bookmark the article:

```
Tool: bookmark_item
Params: {
  feed_url: <url of the feed>,
  item_index: <index of chosen article>
}
```

Save as `bookmark_id`.

Step 3 - Create a linked task:

```
Tool: create_task
Params: {
  title: "Demo: Share relevant article with Priya before discovery call",
  description: "Bookmarked article from tech feeds - could be good context for the Northstar conversation.",
  priority: "medium",
  due_date: "<2 days from now YYYY-MM-DD>",
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_northstar_id> }]
}
```

Save as `task_article_id`.

> "Bookmarked and linked. Now when you pull up Northstar's entity card,
> this task shows up right alongside the playbook tasks. Your feed reading
> just became part of your sales process. That's the kind of connection
> that falls through the cracks when your feeds, tasks, and CRM live in
> different apps."

### Fallback (if feeds are unavailable)

If the feed subscription failed or returned no items, skip the bookmark and
instead create the task with a slightly different framing:

> "Your feeds seem quiet right now, but let me show you what this looks
> like. Imagine you read an article about warehouse automation trends -
> perfect for the Northstar discovery call. Let's create a task to
> research that topic and link it to the deal."

```
Tool: create_task
Params: {
  title: "Demo: Research warehouse automation trends for Northstar discovery",
  description: "Context building for discovery call with Priya.",
  priority: "medium",
  due_date: "<2 days from now YYYY-MM-DD>",
  tags: ["demorun-run-my-week-<run_id>"],
  links: [{ entity_type: "customer", entity_id: <customer_northstar_id> }]
}
```

Save as `task_article_id`.

**Pause here.**

---

## Scene 5: Triage - "What's stuck?"

**Day label:** FRIDAY (morning)
**What the user sees:** The user takes the wheel. They see what's blocked or
overdue and decide what to do about each item.

### What to tell the user

> "It's Friday morning. Time to clear the decks before you close out the
> week. Let's see what's stuck - overdue tasks, blocked items, anything
> that needs attention. This time you're driving. I'll pull up the list
> and you tell me what to do."

### Execute

```
Tool: get_stuck_list
Params: {}
```

### Expected result

The stuck list returns overdue and blocked tasks. It should include at least:
- "Send revised scope to Meridian Health" (overdue, in_progress)
- "Schedule Phase 2 kickoff with Jordan" (blocked by the overdue task)

It may also include other tasks from the user's real workspace. Focus the
conversation on the demo tasks.

### What to explain after

Present the stuck list with the FRIDAY (morning) day header at the top.
For each stuck demo item, offer choices:

**For the overdue task ("Send revised scope to Meridian Health"):**

> "This one's been sitting for three days. What do you want to do?"

Present options and let the user choose:
- "Mark it done - I already sent it"
- "I'll do it today - keep it in progress"
- "Assign it to @claude to draft"
- Or whatever the user says

If the user marks it done:

```
Tool: complete_task
Params: { task_id: <task_overdue_id> }
```

Note: completing this task should unblock "Schedule Phase 2 kickoff with
Jordan." After completing, show the blocked task's status change:

> "And look - completing that task just unblocked 'Schedule Phase 2 kickoff
> with Jordan.' The dependency resolved automatically."

If the user assigns to @claude, update the task:

```
Tool: update_task
Params: {
  task_id: <task_overdue_id>,
  assigned_to: "@claude"
}
```

**For the blocked task (if it got unblocked):**

If the overdue task was completed, the blocked task is now actionable. Ask
the user if they want to set a due date for it or leave it for now.

**For any other stuck items from real data:**

Acknowledge them but don't act on them unless the user asks: "There are
also a few items from your real workspace in the stuck list. Those are yours
to handle whenever you're ready."

> "That's triage. One pass through the stuck list and you've cleared the
> blockers, moved things forward, and your task board is clean. This is
> something you can do every morning in under a minute."

**Pause here.**

---

## Scene 6: Friday Retro - "What did I get done?"

**Day label:** FRIDAY (afternoon)
**What the user sees:** A weekly summary of accomplishments, a memory stored
for the future, and the full entity card showing everything connected.

### What to tell the user

> "It's Friday afternoon. You had a productive week - new deal in the
> pipeline, payment received, tasks cleared. Let's see what the numbers
> say. In Founders OS, you can ask for a weekly retro and the system pulls
> together everything you accomplished."

### Execute

Step 1 - Pull the weekly retro:

```
Tool: get_weekly_retro
Params: {}
```

### Expected result

The retro returns completed tasks for the week, interactions logged, financial
activity, and other work summaries. It should include the tasks completed
during the demo (delivering wireframes, possibly the scope task from triage).

### What to explain after

Present the retro with the FRIDAY (afternoon) day header at the top.
Walk through the highlights:

> "Here's your week. Tasks completed, interactions logged, money that came
> in, deals that moved forward. This is everything the system tracked
> automatically - you didn't have to write any of this up."

Step 2 - Store a decision in memory:

> "Before you close out the week, there's a decision worth remembering.
> You're going after the Northstar deal, and Priya mentioned a 3-4 week
> timeline. Let's make sure the system remembers that."

Present the user with a few options for what to store, but let them say
anything:

- "Northstar Robotics has a 3-4 week timeline. Priya wants to start the UX
  engagement by mid-June."
- "We're prioritizing the Northstar deal over new outbound this month."
- "Priya at Northstar prefers technical depth in proposals - she's a CTO,
  not a business buyer."
- Or whatever the user wants to store

Once the user decides:

```
Tool: memory_store
Params: {
  content: <whatever the user chose>,
  scope: "org",
  project: "demorun-run-my-week-<run_id>",
  source_tool: "demo"
}
```

Save as `memory_northstar_id`.

Step 3 - Prove the recall:

```
Tool: memory_recall
Params: {
  query: "Northstar Robotics",
  limit: 3
}
```

Present the results:

> "Stored. And look - the system can already find it. Next week, next month,
> in a completely different conversation, if you ask 'what do I know about
> Northstar?' that note is right there. Same goes for the Meridian preferences
> we stored earlier."

Step 4 - Show the final entity card for Northstar:

```
Tool: get_entity_card
Params: {
  entity_type: "customer",
  entity_id: <customer_northstar_id>
}
```

> "And here's the full picture on Northstar after one week. Customer record,
> contact, the inbound email, six playbook tasks in motion, an article task
> linked to the deal, and a memory about their timeline. All of this was
> created through natural conversation. No forms, no data entry, no
> switching between apps. Just talking about your work and letting the
> system organize it."

**Pause here.**

---

## Summary

### What to tell the user

> "That's one week with Founders OS. You checked in on Monday and saw your
> whole business in one view. A new lead came in and you had a full sales
> process running in under a minute. A payment arrived and it was logged,
> taxed, and visible on the client's record immediately. You spotted a
> relevant article and turned it into a linked task. You triaged what was
> stuck and cleared the blockers. And you closed the week knowing exactly
> what you accomplished.
>
> The thing that makes this different from using five separate tools is
> that everything is connected. The payment shows up on the client card.
> The playbook tasks show up in your morning briefing. The article you
> bookmarked is linked to the deal. The memory you stored is searchable
> across sessions. Nothing falls through the cracks because there are no
> cracks - it's one system."

### Ways to ask

Present a visual reference card organized by intent:

**Start your day**
- "Catch me up"
- "What's on my plate today?"
- "Give me my morning briefing"

**Manage your pipeline**
- "I just met someone at a conference - add them"
- "Run the sales playbook for Acme Corp"
- "What's the full picture on Northstar?"

**Track money**
- "Log a $5,000 payment from Meridian"
- "Transfer 25% to tax reserve"
- "How's my P&L this month?"

**Stay current**
- "What's new in my feeds?"
- "Bookmark that article"
- "Show me what I've saved"

**Clear the blockers**
- "What's stuck?"
- "Mark the scope task as done"
- "Assign the research to @claude"

**Close out the week**
- "What did I get done this week?"
- "Remember that Northstar has a June deadline"
- "What do I know about Priya?"

### What's next

> "There are deeper demos for each area if you want to explore further."

Present the other demos as a visual list:

- **Financial Tools** - Full bookkeeping workflow with accounts, transfers,
  and P&L reports
- **Playbooks** - Build and customize your own process templates
- **RSS Feeds** - Subscribe to feeds, set up your morning briefing
- **Memory** - Semantic search, duplicate detection, session summaries
- **Tagging** - Keep your vocabulary consistent as your system grows
- **Conflict Resolution** - See how the system handles ambiguity

> "You can try any of these by asking your agent to run that demo. Ready
> for cleanup?"

**Pause here.** Wait for the user to confirm before cleaning up.

---

## Phase 7: Cleanup

Delete everything created during the demo in reverse dependency order.

### 7a. Delete demo memories

```
Tool: memory_forget
Params: { memory_id: <memory_northstar_id>, resolution: "confirm" }

Tool: memory_forget
Params: { memory_id: <memory_meridian_id>, resolution: "confirm" }
```

### 7b. Remove feed bookmark

If a bookmark was created:

```
Tool: remove_bookmark
Params: { bookmark_id: <bookmark_id> }
```

### 7c. Unsubscribe demo feed (guarded)

Unsubscribe ONLY the feed this run created. If `feed_created_by_run` is true,
remove it:

```
Tool: unsubscribe_feed
Params: { feed_id: <feed_hn_id> }
```

If `feed_created_by_run` is false - the user was already subscribed when the demo
started - skip this step entirely. Never unsubscribe a pre-existing feed; it is
the user's real subscription. When in doubt, do not unsubscribe. (The server-side
reaper does not reap feed subscriptions, so this in-session step is what removes
a run-created feed.)

### 7d. Delete all demo tasks

First, sweep by tag to catch everything:

```
Tool: list_tasks
Params: { tag: "demorun-run-my-week-<run_id>" }
```

Also get tasks linked to both demo customers:

```
Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <customer_northstar_id> }

Tool: list_entity_tasks
Params: { entity_type: "customer", entity_id: <customer_meridian_id> }
```

Combine all lists, deduplicate by ID, and delete each one:

```
Tool: remove_task
Params: { task_id: <task_id>, resolution: "confirm" }
```

Repeat for every task found. This includes the 4 seed tasks, the article
task, and all 6 playbook-generated tasks.

### 7e. Delete the playbook

```
Tool: remove_playbook
Params: { playbook_id: <playbook_id>, resolution: "confirm" }
```

### 7f. Delete demo transactions

Delete the prior expense:

```
Tool: remove_transaction
Params: { transaction_id: <tx_prior_id>, resolution: "confirm" }
```

Delete the Meridian payment:

```
Tool: remove_transaction
Params: { transaction_id: <tx_meridian_id>, resolution: "confirm" }
```

Delete the transfer (both legs):

```
Tool: remove_transaction
Params: { transaction_id: <transfer_out_id>, resolution: "confirm" }
```

### 7g. Archive demo accounts

```
Tool: remove_account
Params: { account_id: <checking_id>, resolution: "confirm" }

Tool: remove_account
Params: { account_id: <tax_reserve_id>, resolution: "confirm" }
```

### 7h. Delete demo customers

Deleting a customer with `resolution: "confirm"` now cascades: its still-live
contacts and interactions are soft-deleted in the same step, so they no
longer orphan during the 30-day recovery window. You can still delete the
contacts explicitly first if you want their removal logged separately, but
it is no longer required to avoid leftovers.

```
Tool: remove_customer
Params: { customer_id: <customer_northstar_id>, resolution: "confirm" }

Tool: remove_customer
Params: { customer_id: <customer_meridian_id>, resolution: "confirm" }
```

If remove_customer returns a conflict about remaining data, the
`resolution: "confirm"` param should skip the conflict prompt automatically.

### 7i. Sweep for stragglers

```
Tool: list_tasks
Params: { tag: "demorun-run-my-week-<run_id>" }

Tool: list_interactions
Params: { customer_id: <customer_northstar_id> }

Tool: list_interactions
Params: { customer_id: <customer_meridian_id> }
```

Both demo customers' interactions should already be gone via the cascade in
7h. If any interaction still shows as live, delete it explicitly:

```
Tool: remove_interaction
Params: { interaction_id: <interaction_id>, resolution: "confirm" }
```

For customer name searches, match only on records carrying the
`demorun-run-my-week-<run_id>` tag - never delete a customer by name alone, since
real records can share a name with a demo fixture.

Delete anything that remains that is tagged `demorun-run-my-week-<run_id>`.

### 7j. Delete the demo tag

```
Tool: list_tags
Params: {}
```

Find the `demorun-run-my-week-<run_id>` tag and delete it:

```
Tool: remove_tag
Params: { tag_id: <tag_demo_id>, resolution: "confirm", cascade: true }
```

### 7k. Delete demo categories

```
Tool: remove_category
Params: { category_id: <cat_revenue_id>, resolution: "confirm" }

Tool: remove_category
Params: { category_id: <cat_software_id>, resolution: "confirm" }

Tool: remove_category
Params: { category_id: <cat_transfer_id>, resolution: "confirm" }
```

### 7l. Confirm cleanup

> "All done. I removed the demo customers, contacts, tasks, playbook,
> transactions, accounts, categories, memories, feed data, and tags.
> Everything from the walkthrough has been cleaned up.
>
> If you'd like to start using Founders OS for real, just start talking.
> 'Add a customer,' 'catch me up,' 'what's my P&L' - the system is
> ready."
