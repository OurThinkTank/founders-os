---
category: welcome
---

# Welcome to Founders OS - Interactive Demo

> **What is this?** Your first look at Founders OS. This short walkthrough
> simulates a typical morning - checking in, capturing a new lead, creating
> a follow-up, and storing a note for later. You'll watch the first half and
> take the wheel in the second half. Everything created during the demo is
> cleaned up at the end.
>
> **Who is this for?** Anyone trying Founders OS for the first time,
> technical or not. No setup required beyond having the server running.
>
> **How to use it:** Tell your AI agent: *"Read the welcome demo and walk me
> through it."* The agent will guide you step by step, pausing along the way
> for you to continue.

---

## Prerequisites

- **Founders OS v0.6.0 or later.** Call `get_version` at the start and
  confirm the running version is >= 0.6.0. If it's older, stop and explain.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** plus these
demo-specific rules:

- **Demo key:** `welcome` (run tag is `demorun-welcome-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.6.0
- **This demo has two modes.** Scenes 1-2 are agent-led: the agent
  narrates and executes while the user watches. Scenes 3-4 are user-led:
  the agent asks the user to make choices and then carries them out. Make
  this transition feel natural, not abrupt. A simple "Now it's your turn"
  is enough.
- **Hide the tool names.** This demo targets non-technical founders. Never
  say "I'm going to call add_customer" or "using the create_task tool."
  Instead, describe the action in plain language: "Let's add them to your
  pipeline" or "Let's make a task so you don't forget." The user should
  experience the system as a conversation, not a command line.
- **Keep widgets simple.** This is the user's first demo. Use the standard
  visual patterns from DEMO_RULES.md but lean toward fewer, cleaner
  widgets rather than dense ones. One clear visual per scene is better
  than three busy ones.
- **No external tools.** This demo is entirely self-contained inside
  Founders OS. Do not call Slack, calendar, GitHub, or other connectors.

---

## The Story

Here's the scenario that ties everything together. The agent should
internalize this and narrate naturally - not read it to the user verbatim.

It's Monday morning. You sit down, open up your AI assistant, and check in
with Founders OS for the first time today. Over the weekend, you attended a
local startup meetup and hit it off with Maya Torres, the founder of a
small design studio called Greenline Studio. She mentioned her team might
need help with a project. You exchanged contact info and said you'd follow
up this week.

That's the thread the demo follows: from morning check-in, to capturing
the lead, to creating a follow-up task, to storing a note about Maya's
preferences so the system remembers next time.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Welcome the user

Explain in 3-4 conversational sentences:

- **What they're about to see.** A quick walk through a typical morning
  with Founders OS - how you check in, track a new lead, stay on top of
  follow-ups, and keep notes the system can recall later.
- **How the demo works.** There are four short scenes. In the first two,
  the agent drives and the user watches. In the last two, the user gets to
  make some choices. The whole thing takes about five minutes.
- **Cleanup.** Everything created is temporary and gets removed at the end.

After the verbal orientation, present a small visual showing a handful of
example phrases. The point is to reassure the user that they can just talk
naturally - there's no special syntax or commands to learn. Keep it to 5-6
short phrases, grouped loosely, with a one-line intro like "You can talk
to Founders OS the way you'd talk to a colleague." Examples:

- "Catch me up"
- "I met someone at a conference - can you add them?"
- "Remind me to follow up with Maya by Friday"
- "What's going on with Greenline?"
- "Remember that Maya prefers email"
- "What do I know about Greenline?"

Don't explain each phrase. Let the list speak for itself. The demo will
prove each of these patterns over the next few scenes.

Then proceed to seeding.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-welcome-<run_id>",
  description: "Ephemeral Welcome demo run tag"
}
```

Save as `tag_demo_id`. This run tag goes on every record the demo creates, so
cleanup can find exactly this run's data and nothing else.

### 0c. Confirm setup

Present a brief visual confirming the stage is set (the run is tagged so it can
be removed cleanly at the end). Then prompt the user to say "next" or
"continue" to begin.

**Pause here.**

---

## Scene 1: Good Morning - "Catch me up"

**What the user sees:** The morning check-in experience. A snapshot of
tasks, pipeline activity, and signals across the system.

### What to tell the user

> "Imagine it's Monday morning. You just sat down with your coffee and you
> want to know what's going on. In Founders OS, you can just ask 'catch me
> up' and the system pulls together everything that matters - your tasks,
> your pipeline, anything that needs attention. Let me show you what that
> looks like."

### Execute

```
Tool: get_session_start
Params: {}
```

### Expected result

The session start returns a cross-domain summary: task counts, overdue
items, CRM activity, financial pulse, feed unread counts, and suggested
actions. Some sections may be empty if the user is new - that's fine and
worth noting naturally ("It's pretty quiet right now, which makes sense
if you're just getting started").

### What to explain after

Present the session start results visually. Walk through what each section
represents in plain language:

- "This top section is your task overview - what's due, what's overdue,
  what's coming up."
- "Down here is your pipeline - how many leads or customers you're
  tracking."
- "And this is your news digest and financial pulse - a quick glance at
  what's happening."

Don't dwell on empty sections. If something is empty, acknowledge it
briefly and move on. The point is to show the user that one question gives
them a full picture.

> "That's it - one question and you know where you stand. Now let's give
> the system something to work with."

**Pause here.**

---

## Scene 2: A New Lead - "You just met someone"

**What the user sees:** A new customer, contact, and interaction record
being created and connected automatically.

### What to tell the user

> "Over the weekend you went to a startup meetup and met Maya Torres. She
> runs a design studio called Greenline Studio, and she mentioned her team
> might need help with a project. You exchanged info and said you'd follow
> up. Let's capture that before it slips through the cracks."

### Execute

Step 1 - Add the customer:

```
Tool: add_customer
Params: {
  organization_name: "Greenline Studio (demo <run_id>)",
  customer_type: "client",
  customer_phase: "prospect",
  website: "https://greenlinestudio.example.com",
  notes: "Design studio, met founder Maya at startup meetup. Potential project collaboration.",
  tags: ["demorun-welcome-<run_id>"]
}
```

Save as `customer_greenline_id`.

Step 2 - Add the contact:

```
Tool: add_contact
Params: {
  customer_id: <customer_greenline_id>,
  first_name: "Maya",
  last_name: "Torres",
  role: "Founder",
  email: "maya@greenlinestudio.example.com",
  is_primary: true
}
```

Save as `contact_maya_id`.

Step 3 - Log the interaction:

```
Tool: log_interaction
Params: {
  customer_id: <customer_greenline_id>,
  contact_id: <contact_maya_id>,
  interaction_type: "event",
  subject: "Met at startup meetup",
  body: "Had a great conversation about design systems and workflow tools. Maya mentioned her team is growing and they might need help on an upcoming project. Said to follow up this week."
}
```

Save as `interaction_meetup_id`.

### Expected result

Three records created and linked: a customer (Greenline Studio), a contact
(Maya Torres), and an interaction (the meetup conversation). The contact is
marked as primary. The customer carries this run's tag
(`demorun-welcome-<run_id>`), and its name is suffixed `(demo <run_id>)` so it
cannot collide with another run.

### What to explain after

Present the results visually - show the customer with Maya listed as the
contact and the meetup interaction logged. Explain in plain language:

> "So now Greenline Studio is in your pipeline as a prospect. Maya is
> listed as the main contact, and the conversation you had at the meetup
> is logged so you don't lose the context. Everything is connected - if
> you ask 'what's going on with Greenline?' later, all of this shows up
> together."

Then transition to the hands-on portion:

> "That's how capturing a new lead works. Now it's your turn - let's
> create a follow-up task so you don't forget to reach out to Maya."

**Pause here.**

---

## Scene 3: Your Turn - "Don't forget to follow up"

**What the user sees:** The agent asks what follow-up they'd like to
create, then makes it happen.

### What to tell the user

> "You told Maya you'd follow up this week. Let's make sure that actually
> happens. I'll create a task and link it to Greenline Studio so everything
> stays connected. What should the follow-up be? Something like 'Send Maya
> an intro email' or 'Schedule a call with Maya' - whatever feels right.
> And when should it be due?"

### Execute

Present the user with options and let them choose. Suggest a few ideas
but make it clear they can say anything:

- "Send intro email to Maya at Greenline"
- "Schedule a discovery call with Maya"
- "Share portfolio with Maya Torres"
- Or they can type their own

For the due date, suggest "this Wednesday" or "this Friday" but accept
whatever they say.

Once the user decides:

```
Tool: create_task
Params: {
  title: <whatever the user chose>,
  description: "Follow up from startup meetup conversation. Maya mentioned potential project work.",
  priority: "high",
  due_date: <whatever the user chose>,
  tags: ["demorun-welcome-<run_id>"],
  links: [{
    entity_type: "customer",
    entity_id: <customer_greenline_id>
  }]
}
```

Save as `task_followup_id`.

### Expected result

A task created with high priority, linked to the Greenline Studio customer
record, tagged with this run's tag (`demorun-welcome-<run_id>`).

### What to explain after

Show the task visually, highlighting that it's linked to the customer.
Then show the full picture by pulling up the entity card:

```
Tool: get_entity_card
Params: {
  entity_type: "customer",
  entity_id: <customer_greenline_id>
}
```

Present the entity card result visually - the customer record with the
contact, the logged interaction, and now the follow-up task all together.

> "See how it all connects? One customer record, one contact, one
> conversation from the meetup, and now your follow-up task. Next time
> you ask 'what's going on with Greenline?' all of this shows up in one
> place. You don't have to go hunting for it."

**Pause here.**

---

## Scene 4: Making It Stick - "Remember this for later"

**What the user sees:** The system stores a note and immediately proves
it can recall it.

### What to tell the user

> "One last thing. During your conversation with Maya, you probably picked
> up some detail worth remembering - maybe she mentioned a deadline, a
> preference, or something about how she likes to work. Founders OS has a
> memory system that stores notes like this and can recall them later,
> even in a different conversation. What's something worth remembering
> about Maya or Greenline?"

### Execute

Present the user with a few ideas but let them type their own:

- "Maya prefers async communication - email over calls"
- "Greenline is redesigning their brand this quarter"
- "Maya mentioned a June deadline for the new project"
- Or whatever the user wants to store

Once the user decides:

```
Tool: memory_store
Params: {
  content: <whatever the user chose>,
  scope: "org",
  project: "demorun-welcome-<run_id>"
}
```

The `project` stamp ties this note to the run so cleanup (and the server-side
reaper) can find it precisely.

Save as `memory_id`.

Then immediately prove the recall works:

```
Tool: memory_recall
Params: {
  query: "Maya Torres Greenline",
  limit: 3
}
```

### Expected result

The memory is stored, then the recall returns it (among any other relevant
memories). The user sees that what they just said is already searchable.

### What to explain after

Present the recall result visually - show the stored memory coming back
in the search results.

> "That's it - the system remembered what you told it, and it can find it
> again just by searching for Maya or Greenline. This works across
> sessions, so if you come back tomorrow and ask 'what do I know about
> Maya?' it's right there. No digging through notes or old messages."

**Pause here.**

---

## Summary

### What to tell the user

> "That's your first morning with Founders OS. In about five minutes you
> checked in on your day, captured a new lead with full context, created a
> follow-up task linked to that lead, and stored a note the system can
> recall anytime. And everything you just did, you could have done by just
> asking naturally - 'add Greenline as a prospect,' 'remind me to email
> Maya by Wednesday,' 'remember that Maya prefers email.' The system
> figures out the rest."

### Ways to ask

Before moving to what's next, present a visual reference card organized
by intent - what the user wants to do, not which feature it maps to.
Each row has a short intent label and 2-3 example phrases. Introduce it
with something like:

> "Here's a quick cheat sheet. None of these are exact commands - they're
> just examples of how people talk to Founders OS. Say it however feels
> natural and the system will figure out the rest."

**Check in on your day**
- "Catch me up"
- "What's on my plate today?"
- "Anything overdue?"

**Track a new lead**
- "I met someone at a conference - can you add them?"
- "Add Acme Corp as a prospect"
- "New lead: Maya Torres, runs a design studio called Greenline"

**Stay on top of follow-ups**
- "Remind me to email Maya by Friday"
- "Create a task: send proposal to Acme, due next week"
- "What tasks are linked to Greenline?"

**Get the full picture on someone**
- "What's going on with Greenline?"
- "Show me everything about Acme"
- "When did I last talk to Maya?"

**Remember something for later**
- "Remember that Maya prefers email over calls"
- "What do I know about Greenline?"
- "Store a note: their team is growing, might need help in June"

**Look back on your week**
- "What did I get done last week?"
- "Show me stuck tasks"
- "Help me write a LinkedIn post about what I shipped"

**Money and finances**
- "What's my financial summary?"
- "Log a $500 expense for software"
- "How's my P&L looking this month?"

Keep the visual clean - a simple list with clear groupings, not a dense
table. The user should be able to scan it in a few seconds and think
"oh, I can just say stuff like that."

### What's next

> "There are more demos that go deeper into specific areas."

Present the available demos as a visual list. For each one, show the name
and a one-line description of what it covers:

- **Financial Tools** - Set up accounts, record income and expenses, run
  reports
- **Playbooks** - Build reusable templates that automate your setup work
  for new deals
- **Tagging** - Organize everything with a shared vocabulary the system
  helps keep consistent
- **Conflict Resolution** - See how the system handles ambiguity and asks
  you to decide instead of guessing

> "You can try any of these by asking your agent to run that demo. Ready
> for cleanup?"

**Pause here.** Wait for the user to confirm before cleaning up.

---

## Phase 5: Cleanup

Remove everything created during the demo, in this order:

### Step 1: Remove the follow-up task

```
Tool: remove_task
Params: {
  task_id: <task_followup_id>,
  resolution: "confirm"
}
```

### Step 2: Remove the customer

Removing a customer cascades to its contacts and interactions, so this
single call removes Greenline Studio, Maya Torres, and the meetup
interaction record.

```
Tool: remove_customer
Params: {
  customer_id: <customer_greenline_id>,
  resolution: "confirm"
}
```

### Step 3: Sweep for stragglers

```
Tool: list_tasks
Params: {
  tag: "demorun-welcome-<run_id>"
}
```

If any tasks remain, remove them.

```
Tool: list_customers
Params: {
  tag: "demorun-welcome-<run_id>"
}
```

If any customers remain, remove them.

### Step 4: Clean up the memory

The memory stored in Scene 4 was demo data. Use `memory_forget` to remove
it:

```
Tool: memory_forget
Params: {
  memory_id: <memory_id>,
  resolution: "confirm"
}
```

### Step 5: Remove the demo tag

```
Tool: remove_tag
Params: {
  tag_id: <tag_demo_id>,
  resolution: "confirm",
  cascade: true
}
```

### Confirm cleanup

> "All done - the demo data has been removed. Your Founders OS instance
> is clean. If you'd like to explore more, just ask me to run one of the
> other demos, or start using it for real. There's no wrong way to begin."
