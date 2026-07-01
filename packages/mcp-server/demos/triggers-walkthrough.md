---
category: domain
---

# Triggers: The OS That Watches For You

> **What is this?** A guided, visual walkthrough of Founders OS triggers. A
> trigger is a declarative watch: a plain statement of a situation worth reacting
> to, stored as data. Founders OS evaluates your watches deterministically,
> tells you which ones just fired, and hands each one to your agent with a short
> brief and a ready next step. Triggers are what make the OS proactive instead of
> waiting to be asked.
>
> Triggers are one half of a pair. They make the OS act on its own. The
> governance gate, covered in its own demo, makes that safe. This walkthrough
> shows them working together: a watch fires, and before the agent messages
> anyone, the action passes through the gate.
>
> **Who is this for?** Anyone evaluating how Founders OS goes from a tool you
> query to a system that surfaces what needs attention before you think to look.
>
> **How to use it:** Tell your AI agent: *"Read the triggers demo and walk me
> through it."* The agent guides you scene by scene and pauses after each one so
> you can ask questions or move on.

---

## Prerequisites

The Proactive Agents tools must be available. Triggers: `create_trigger`,
`list_triggers`, `update_trigger`, `delete_trigger`, `evaluate_triggers`,
`report_trigger_observation`. Governance, used in Scene 3: `preview_action`,
`execute_action`, `list_pending_approvals`. Call `get_version` at the start. If
`create_trigger` is not present, stop and explain that this build predates the
feature.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory), plus
these demo specific rules:

- **Demo key:** `triggers`. Run tag is `demorun-triggers-<run_id>`. See Run
  isolation in DEMO_RULES.md. Every seeded fixture and every created trigger
  carries this tag in its name or is tracked by id for cleanup.
- **This demo is highly visual.** Every scene has an explicit widget. When
  `show_widget` is available, render the widget described in each scene.
  Otherwise fall back to the markdown patterns in DEMO_RULES.md. Never dump raw
  JSON.
- **This demo is interactive.** Use `AskUserQuestion` for every decision point so
  the user clicks rather than types. Use `sendPrompt` navigation buttons to move
  between scenes.
- **Always scope evaluation to this demo's conditions.** When you call
  `evaluate_triggers`, always pass `condition_types` limited to the conditions
  this demo created. This keeps the demo from sweeping unrelated watches the user
  may already have running. Evaluation is read only and deduped, so it is safe,
  but stay scoped anyway.
- **Never actually call an external connector.** In Scene 3 the fired action is a
  *proposed* message you pass to `preview_action` only. In Scene 5 you simulate
  checking a billing tool rather than calling one. Do not call Slack, Stripe, or
  any other connector, even if one is connected.
- **The agent does not act on a fired trigger by itself.** Every fired action is
  routed through the gate first. That handoff is the point of Scene 3, not a
  detour.

---

## Phase 0: Setup

### 0-runid. Mint the run id

Mint a `run_id` as described in Run isolation (DEMO_RULES.md): 8 characters,
lowercase base36, random (for example `k3p9zq4m`). Hold it for the whole run.
Every fixture and every cleanup step below uses it.

### 0-intro. Give the user a short orientation

Explain in 3 or 4 conversational sentences, not a bulleted list:

- Most tools answer when you ask. Triggers flip that around. You write down the
  situations worth reacting to once, and Founders OS watches for them so you do
  not have to remember to check.
- You will set up a watch, see it fire against real data, watch the agent hand
  that off to the governance gate before acting, see that the same watch does not
  nag you twice, and look at a watch that lives in an outside tool.
- Everything created in this demo is tagged and removed at the end. Nothing
  permanent is left behind.

Then render **the watch loop** so the user has a mental model for everything that
follows.

**Widget: the watch loop.** A simple horizontal flow of four steps connected by
arrows: Watch (a saved condition), Evaluate (Founders OS checks it on a
schedule), Fire (only what newly became true, with a brief), Gate (the agent
routes any real world action through governance before acting). Keep it compact.
Use CSS variables for color, never hardcoded hex.

Place a standalone "Set up the demo data" button after your wrap up that calls
`sendPrompt` with the seed trigger phrase.

### 0-seed. Create the seed data

Create the run tag first.

```
Tool: create_tag
Params: { name: "demorun-triggers-<run_id>", description: "Ephemeral triggers demo run tag" }
```

Save the returned `tag_id`; cleanup uses it. Create a customer to give the
scenario context.

```
Tool: add_customer
Params: { organization_name: "Northwind Traders (demo <run_id>)", customer_type: "client", customer_phase: "customer", tags: ["demorun-triggers-<run_id>"], notes: "Demo customer for the triggers walkthrough. Safe to delete." }
```

Save the `customer_id`. Now create a task that is already past due, so a watch has
something real to find. Set `due_date` to roughly a week ago (compute a date 7
days before today).

```
Tool: create_task
Params: { title: "Send Northwind the renewal quote (demo <run_id>)", scope: "org", status: "todo", due_date: "<a date about 7 days ago, YYYY-MM-DD>", priority: "high", tags: ["demorun-triggers-<run_id>"], description: "Intentionally overdue so the triggers demo has a real condition to catch." }
```

Save the `task_id`.

**Widget: setup summary.** A small grid of metric style cards, one per created
item: the run tag, the Northwind customer, and the overdue task with its due
date. Use the setup summary pattern from DEMO_RULES.md.

Place a standalone "Start scene 1" button after your wrap up.

---

## Phase 1: Scenarios

### Scene 1: Write a watch, and see what the OS is watching

Narrate: instead of reminding yourself to chase overdue work, you tell Founders
OS to watch for it once. Create a watch for overdue tasks. When it fires, its
intent is to post a heads up to the team. The agent will not send anything on its
own; you will see why in Scene 3.

```
Tool: create_trigger
Params: { name: "Overdue work heads-up (demo <run_id>)", condition_type: "overdue_task", condition_source: "data", action_type: "notify", action_params: { channel: "#ops", text: "Heads up: there is overdue work that has slipped past its due date." }, cadence_hint: "daily", params: {} }
```

Save the `trigger_id`. Now show the watch list, which is also the answer to the
question "what is Founders OS watching for me right now?"

```
Tool: list_triggers
Params: {}
```

**Widget: watch list.** Render the triggers grouped into enabled and disabled,
using the status groups pattern. Each row shows the watch name, a data or
connector badge, the condition in plain language (overdue tasks), and the cadence
(daily). Highlight the watch you just created.

Takeaway: a watch is just data. You can list it, retune it, pause it, or delete
it, and it keeps working whether or not anyone is looking.

Place a standalone "Next: the watch fires" button after your wrap up.

### Scene 2: The watch fires

Narrate: now run the watches. Founders OS checks each condition, and reports only
the ones that newly became true, each with a short brief. The overdue task you
seeded should trip the overdue work watch.

```
Tool: evaluate_triggers
Params: { condition_types: ["overdue_task"] }
```

The response lists the fired watch with its brief.

**Widget: fired card.** A raised card with an informational left border accent.
Header is an alert icon next to FIRED. Inside, show the watch name, the brief it
returned (for example, one overdue task), and the next step it carries: route the
action through the gate before doing anything. Use CSS variables.

Explain what just happened in plain language. Founders OS did the detecting, which
is deterministic and cheap, so the agent's attention goes to deciding what to do,
not to rediscovering the problem.

Place a standalone "Next: hand it to the gate" button after your wrap up.

### Scene 3: Before acting, the agent asks the gate

Narrate: the watch wants to post a message to the team. That writes to an outside
tool, so the agent does not just send it. It runs the proposed message through
the governance gate first. This is the whole idea of autonomous but governed:
the watch makes the OS proactive, and the gate keeps it safe.

```
Tool: preview_action
Params: { action: { kind: "external", connector: "slack", action: "send_message", params: { channel: "#ops", text: "Heads up: the Northwind renewal quote is overdue. Worth chasing today." }, summary: "Post an overdue-work heads-up to the ops channel" }, source: "trigger" }
```

The outcome is `hold_for_approval`, because writing to an outside tool is held by
default.

**Widget: held action callout.** A raised card with an amber left border accent.
Header is an alert icon next to HELD FOR APPROVAL. Show the proposed message
exactly as it would be sent, the tier chip (external write), and a status line:
waiting for a human. Use CSS variables.

Show what is waiting.

```
Tool: list_pending_approvals
Params: {}
```

Render the pending queue as a vertical list, one row per held item, with a tier
chip, the summary, and a HELD badge.

Now make it a real choice. Use `AskUserQuestion` to ask what the user wants to do:
Approve it, Reject it, or Leave it in the queue. Explain that approving is a
human's job. In production this is a Slack approval button or a teammate
approving in their own session. The agent cannot approve its own held action, by
design; it only reads the decision. Follow whatever they pick, and do not perform
the actual send regardless. If they want to see the full approve and clear flow in
detail, point them to the governance gate demo, which covers it end to end.

Place a standalone "Next: it won't nag you twice" button after your wrap up.

### Scene 4: The same watch does not fire twice

Narrate: a good watch tells you once when something becomes true, not on every
single check. Run the watches again. Nothing about the overdue task has changed
since the last run, so the watch stays quiet.

```
Tool: evaluate_triggers
Params: { condition_types: ["overdue_task"] }
```

This time the fired list is empty.

**Widget: all quiet card.** A simple card with a green check icon and the label
ALL QUIET. One line underneath: nothing new since the last check. Use CSS
variables.

Explain the idea without jargon. Founders OS remembers the state it already told
you about. The watch fires again only if the situation worsens, for example if
the task slips further past due into a later stage. You get signal, not noise.

Place a standalone "Next: a watch in an outside tool" button after your wrap up.

### Scene 5: A watch that lives in an outside tool

Narrate: some things worth watching do not live inside Founders OS, like whether
an invoice in your billing tool has gone unpaid. Founders OS still owns the watch
and the firing decision; it just asks the agent to fetch the current facts from
the connected tool. Create an overdue invoice watch.

```
Tool: create_trigger
Params: { name: "Overdue invoice watch (demo <run_id>)", condition_type: "overdue_invoice", condition_source: "connector", connector: "stripe", action_type: "notify", action_params: { channel: "#finance", text: "An invoice is overdue and may need a nudge." }, cadence_hint: "daily", params: {} }
```

Save the `trigger_id`. Now run the watches including this connector condition.

```
Tool: evaluate_triggers
Params: { condition_types: ["overdue_invoice"] }
```

Instead of firing directly, the response returns a connector check: a request for
the agent to look in the billing tool and report back what it found.

**Widget: connector check card.** A card with an informational accent and the
label CHECK TO RUN. Show the connector (billing tool) and what to fetch (overdue
invoices). Make clear this is a request, not a result yet.

For the demo, do not call a real billing tool. Simulate finding one overdue
invoice and report the observation back so Founders OS can make the firing
decision and dedup it the same way it does for data watches.

```
Tool: report_trigger_observation
Params: { trigger_id: "<the overdue invoice trigger_id>", rows: [{ id: "inv_demo_<run_id>" }], state: "b2", brief: "1 invoice overdue by about two weeks" }
```

Render the result as another fired card, the same style as Scene 2, so the user
sees that a connector watch and a data watch end up in the same place: a fired
item with a brief, ready to route through the gate.

Takeaway: the watch is declarative either way. Whether Founders OS can read the
data itself or has to ask the agent to fetch it, you wrote the intent down once,
and the firing and the dedup stay owned by the OS.

Place a standalone "Wrap up" button after your wrap up.

---

## Phase 2: Cleanup

Remove everything this demo created, keyed strictly to the run tag and the ids you
tracked.

Delete both triggers.

```
Tool: delete_trigger
Params: { trigger_id: "<the overdue task trigger_id>" }

Tool: delete_trigger
Params: { trigger_id: "<the overdue invoice trigger_id>" }
```

Remove the seeded task and customer.

```
Tool: remove_task
Params: { task_id: "<task_id>", resolution: "confirm" }

Tool: remove_customer
Params: { customer_id: "<customer_id>", resolution: "archive" }
```

Remove the run tag last.

```
Tool: remove_tag
Params: { tag_id: "<tag_id from create_tag>", resolution: "confirm", cascade: true }
```

If the user approved the held action in Scene 3 and you minted nothing further,
there is nothing else to undo. If a held action is still listed as waiting, tell
the user it is there and that only a human can approve or reject it. Be honest
that the audit entries the gate wrote in Scene 3 are permanent by design.

---

## Summary

Recap in plain language what the user saw. You wrote down a situation worth
watching once, and Founders OS found a real overdue task without being asked. The
agent did not act on its own; it ran the proposed message through the governance
gate, which held it for a human. Running the watches again stayed quiet, because a
good watch tells you once, not every time. And a watch that lived in an outside
billing tool ended up in exactly the same place as one Founders OS could read
itself: a fired item with a brief, ready for a decision.

The takeaway is the pairing. Triggers make Founders OS proactive, so it surfaces
what needs attention before you think to look. The gate keeps that proactivity
safe, so nothing consequential happens without a human in the loop. Autonomous,
and governed.

### Ways to ask

Render this as a reference card (see DEMO_RULES.md). Quick reference, just say it
however feels natural:

- **Set up a watch:** "Watch for deals that go quiet for two weeks." / "Tell me
  when a task slips past due."
- **See what is watched:** "What is Founders OS watching for me?" / "Show me my
  watches."
- **Run the watches now:** "Check my watches." / "Anything fire today?"
- **Tune a watch:** "Make the overdue watch weekly instead of daily." / "Pause
  the invoice watch."
- **Keep it safe:** "Run my watches, but hold anything before you send it." /
  "Show me what is waiting for approval."
