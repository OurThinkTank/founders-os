---
category: domain
---

# Governance Gate: Approve Before You Act

> **What is this?** A guided, visual walkthrough of the Founders OS governance
> gate. The gate is the layer an agent passes through before it does anything
> consequential. It sorts every proposed action into a risk tier, lets safe work
> proceed, holds risky work for a human, catches actions that would leak your
> private data, records everything in a permanent audit trail, and gives you one
> switch to stop all agent action at once.
>
> The honest framing matters. This gate does not physically block an action,
> because the connectors that send messages or move money live on the agent's
> side of the boundary, not inside Founders OS. What it guarantees is that
> consequential work gets classified, the risky tiers wait for a human who is not
> the agent, and a tamper evident record exists for everything. The promise is
> governed and accountable, not impossible to bypass.
>
> **Who is this for?** Anyone evaluating how Founders OS keeps an autonomous
> agent safe to turn on.
>
> **How to use it:** Tell your AI agent: *"Read the governance gate demo and
> walk me through it."* The agent guides you scene by scene and pauses after each
> one so you can ask questions or move on.

---

## Prerequisites

The Proactive Agents governance tools must be available: `preview_action`,
`execute_action`, `get_policy`, `set_policy`, `pause_agents`, and
`list_pending_approvals`. Call `get_version` at the start. These ship in the
release that introduces Proactive Agents governance. If `preview_action` is not
present, stop and explain that this build predates the feature.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory), plus
these demo specific rules:

- **Demo key:** `governance`. This demo seeds no customers, tasks, or feeds, so
  there is no run tag to apply. Its only footprint is governance policy state and
  audit entries, both handled in Cleanup.
- **This demo is highly visual.** Every scene has an explicit widget. When
  `show_widget` is available, render the widget described in each scene. When it
  is not, fall back to the markdown patterns in DEMO_RULES.md. Never dump raw
  JSON.
- **This demo is interactive.** Use `AskUserQuestion` for every decision point so
  the user clicks rather than types. Use `sendPrompt` navigation buttons to move
  between scenes. Always let the user choose freely and follow whatever they pick.
- **Never actually call an external connector.** Every "send a message", "create
  an issue", or "issue a refund" in this demo is a *proposed* action you pass to
  `preview_action` only. Do not call Slack, GitHub, Stripe, or any other
  connector, even if one is connected. The point is to watch the gate classify
  and hold the action, not to perform it.
- **You are the human approver.** Approval is deliberately a human action.
  `approve_action` is not in the agent's tool set, so the agent cannot approve its
  own held actions. When a scene reaches an approval, explain that in production
  this is a Slack approval button or a teammate acting in their own session, and
  that the agent never self approves. This boundary is the point of the scene, not
  an obstacle to rush past.
- **The audit trail is permanent by design.** This gate writes an immutable
  record of every preview, hold, and decision. Those entries are not deleted at
  cleanup, because a flight recorder you can erase is not a flight recorder. Say
  so plainly when you wrap up.

---

## Phase 0: Setup

### 0-runid. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md): 8
characters, lowercase base36, random (for example `k3p9zq4m`). This demo seeds no
tagged fixtures, but hold the id so any narration that needs a unique label can
use it.

### 0-intro. Give the user a short orientation

Explain in 3 or 4 conversational sentences, not a bulleted list:

- When you let an agent act on your behalf, some actions are harmless, like
  reading data, and some are consequential, like messaging a customer, issuing a
  refund, or sending data to an outside tool. The gate sorts every proposed
  action into a risk tier and decides what happens next.
- You will watch a safe action pass straight through, a consequential action get
  held for your approval, an action that would leak private data get caught and
  flagged in red, and a single switch that pauses every agent at once.
- It guarantees classification, a human in the loop for the risky tiers, and a
  permanent record. It does not promise an action can never happen without
  approval, because the agent holds the connectors. Think accountability, not a
  locked door.

Then, before any tool call, render **the risk ladder** so the user has a mental
model for everything that follows.

**Widget: the risk ladder.** A single vertical ladder of five rungs, lowest risk
at the bottom, highest at the top. Each rung shows the tier name on the left and
its default outcome as a pill on the right. Use the standard color conventions:
green for allow, neutral for allow and log, amber for held, red for the two top
rungs. Use CSS variables, never hardcoded hex.

```
exfiltration   sends private data outward      HELD (red, fixed)
destructive    deletes or overwrites           HELD (red, fixed)
external_write writes to an outside tool        HELD (amber)
native_create  creates inside Founders OS       allow and log
read           reads data                       allow
```

Call out two things about the ladder while it is on screen. The two red rungs
are fixed at held and cannot be lowered, even on purpose. Everything else is a
policy you control, which is what you will look at next.

Place a standalone "Show me the current policy" button after your wrap up that
calls `sendPrompt` with the Phase 0 setup trigger phrase.

### 0-setup. Confirm a known starting policy

Show the current policy so the user sees the defaults.

```
Tool: get_policy
Params: {}
```

**Widget: policy table.** Render the tier to outcome map as a compact two column
table. Show the two red rows (destructive and exfiltration) in bold so they read
as fixed. Below the table, show two status pills: Dry run off and Paused off.
Use CSS variables for all color.

Explain that this is the live rulebook the gate consults on every action. Reading
is allowed, creating a task inside Founders OS is allowed and logged, an external
write is held, and the two red tiers are always held. The red tiers cannot be
lowered, even deliberately.

Place a standalone "Start scene 1" button after your wrap up.

---

## Phase 1: Scenarios

### Scene 1: A safe action passes straight through

Narrate: the agent wants to read the list of invoices from a billing tool. That
is a read, the lowest rung on the ladder, so the gate should let it through
without ceremony.

```
Tool: preview_action
Params: { action: { kind: "external", connector: "stripe", action: "list_invoices" }, source: "agent" }
```

The outcome comes back as `allow`.

**Widget: decision card.** A single card with a green left border accent. Top
line is a green check icon next to the label CLEARED. Show the tier chip (read)
and the outcome (allow). One line underneath: the gate classified this and got
out of the way. Use CSS variables.

Now clear it and let the agent proceed.

```
Tool: execute_action
Params: { confirm_token: "<the confirm_token from preview_action>", action: { kind: "external", connector: "stripe", action: "list_invoices" } }
```

Takeaway: safe work is not slowed down. The gate classified it, recorded that it
happened, and stayed out of the way.

Place a standalone "Next: a risky action gets held" button after your wrap up.

### Scene 2: A consequential action is held for a human

Narrate: now the agent wants to post a message into a customer Slack channel.
That writes to an outside tool, so the gate should hold it.

```
Tool: preview_action
Params: { action: { kind: "external", connector: "slack", action: "send_message", params: { channel: "#acme-account", text: "Following up on next steps for the renewal." }, summary: "Post a renewal follow-up in the Acme channel" }, source: "agent" }
```

The outcome is `hold_for_approval`.

**Widget: held action callout.** A raised card with an amber left border accent.
Header is an alert icon next to the label HELD FOR APPROVAL. Inside, show the
proposed message text exactly as it would be sent, the tier chip (external
write), and a status line: waiting for a human. Use CSS variables.

Then show what is waiting in the queue.

```
Tool: list_pending_approvals
Params: {}
```

**Widget: pending queue.** Render each held item as a row in a vertical list: a
tier chip on the left, the summary in the middle, and a HELD status badge on the
right. This is the approver's inbox.

Now reach the human boundary, and make it a real choice. Use `AskUserQuestion` to
ask the user what they want to do with this held action. Offer: Approve it,
Reject it, and Leave it in the queue. Whatever they choose, explain that
approving is a human's job, not the agent's. In production this is a click on a
Slack approval button or a teammate approving it in their own session. The agent
literally cannot approve this itself, by design. It only ever reads the decision.

Follow their pick honestly:

- If they choose Leave it, say it stays in the queue and move on.
- If they choose Reject, explain that a human rejection means `execute_action`
  will refuse the action from here on.
- If they choose Approve and want to see it actually clear, explain that they
  approve it themselves (the approval action is available to a human, not to the
  agent) and hand the agent the fresh confirmation it returns. The agent then
  clears the action exactly once, and a second attempt is refused. The agent will
  not fake this step.

Place a standalone "Next: catching a data leak" button after your wrap up.

### Scene 3: An action that would leak private data is caught

Narrate: the agent drafts what looks like a friendly introduction message to send
through Slack, but the body carries a customer's email address and a revenue
figure. On the surface it looks helpful and trips no delete warning. Watch what
the gate does.

```
Tool: preview_action
Params: { action: { kind: "external", connector: "slack", action: "send_message", params: { channel: "#partners", text: "Intro: reach Jane at jane.doe@acme.com. Acme is doing $42,500 MRR." }, summary: "Send an intro that includes a contact email and a revenue figure" }, source: "agent" }
```

The tier comes back as `exfiltration`, the top of the ladder, and the outcome is
`hold_for_approval`.

**Widget: exfiltration callout.** A raised card with a bold red left border
accent and a red header: DATA LEAK CAUGHT. Inside, quote the reasons the gate
returns verbatim, each as its own line: a contact email address is being sent
outward, and a financial figure is being sent outward. Below the reasons, show a
small "what tripped it" breakdown with the detected signals (the email and the
revenue value) highlighted inside the message text. Render everything in the red
family using CSS variables, never hardcoded hex.

Explain why this is the subtle one. Nothing here is destructive, so a tool that
only watches for deletions would wave it through. The gate classifies data
movement, not just deletion, which is why an innocent looking message still lands
at the top of the ladder.

Place a standalone "Next: the kill switch" button after your wrap up.

### Scene 4: One switch stops everything

Narrate: suppose you see something you do not like and want every agent to stop
immediately. Flip the company wide pause.

```
Tool: pause_agents
Params: { paused: true }
```

**Widget: pause banner.** A full width red banner with a stop icon and the label
ALL AGENTS PAUSED. One line underneath: no action will be performed company wide
until this is lifted. Use CSS variables.

Now show that even the safe read from Scene 1 no longer proceeds.

```
Tool: preview_action
Params: { action: { kind: "external", connector: "stripe", action: "list_invoices" }, source: "agent" }
```

The outcome is `paused`, and nothing is recorded as held or performed. Show this
as a small decision card with the paused outcome so the contrast with Scene 1 is
obvious: the same read that sailed through before is now stopped.

Lift the pause so the system is back to normal.

```
Tool: pause_agents
Params: { paused: false }
```

Then offer the gentler version of the same idea. Use `AskUserQuestion` to ask
whether the user wants to see dry run mode, which holds and logs every action,
even safe ones, so you can watch what an agent would do before letting it do
anything. If they say yes:

```
Tool: set_policy
Params: { dry_run: true }
```

Re run the safe read from Scene 1 and show that it is now held rather than
allowed, then turn dry run back off as part of Cleanup. If they say no, skip
straight to the wrap up.

Place a standalone "Wrap up" button after your wrap up.

### Scene 5: The flight recorder

Narrate: everything you just did left a permanent mark. The gate records every
preview, every hold, and every decision in an audit trail that cannot be quietly
edited. This is the part that turns "we have rules" into "we can prove what
happened."

**Widget: audit log.** Render an execution log of this session as a vertical
stack, one row per recorded event, in the order they happened. Each row has a
status icon on the left, a plain language label in the middle, and the outcome on
the right. Build it from the actions taken in this run, for example: previewed
the invoice read (allowed), held the Acme renewal message (external write), the
human decision on that message, caught the partner intro as a data leak
(exfiltration, held), paused all agents, and resumed. Use the standard status
colors via CSS variables.

Takeaway: the agent could, in theory, go around the gate, but it cannot do so
invisibly. The record is the backstop, and it is permanent on purpose.

Place a standalone "See the recap" button after your wrap up.

---

## Phase 2: Cleanup

Restore the starting state so the demo leaves nothing surprising behind.

If you turned on dry run, turn it off.

```
Tool: set_policy
Params: { dry_run: false }
```

Make sure pause is off.

```
Tool: pause_agents
Params: { paused: false }
```

If you held an action during the demo and the user did not decide it, it is still
listed as waiting. The agent cannot clear it; only a human can. Tell the user it
is there and that they can approve or reject it themselves whenever they like. The
demo will not approve on their behalf.

Be honest about what remains. The audit entries this demo wrote are permanent.
That is the feature, not a leak. Say so.

---

## Summary

Recap in plain language what the user saw. A safe read passed straight through. A
customer message was held until a human could sign off. A message that would have
carried a contact's email and a revenue number out to an outside tool was caught
and flagged in red. A single switch stopped everything at once. Through all of
it, the system kept a permanent record, and approving stayed firmly a human job.

The honest bottom line: this is governance you can prove, not a wall that cannot
be climbed. The agent could in theory go around the gate, but it cannot do so
invisibly, and the actions that matter most wait for a person who is not the
agent.

### Ways to ask

Render this as a reference card (see DEMO_RULES.md). Quick reference, just say it
however feels natural:

- **Check what the agent would do:** "Preview this before you send it." / "Is
  this safe to do on your own?"
- **See what is waiting on me:** "What is waiting for my approval?" / "Show me
  anything held."
- **Set the rules:** "Hold anything that writes to an outside tool." / "Turn on
  dry run so I can watch first."
- **Stop everything:** "Pause all agents." / "Okay, resume."
- **Prove what happened:** "Show me the audit trail." / "What has the agent done
  so far?"
