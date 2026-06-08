---
category: functional
---

# Memory - Interactive Demo

> **What is this?** A guided walkthrough of how memory works in Founders OS.
> Memory is a shared knowledge base that persists across sessions - decisions,
> context, preferences, and session summaries that your AI agent can store and
> recall later. The system uses semantic search so you can find memories by
> meaning, not just keywords, and it catches near-duplicates before they clutter
> the knowledge base.
>
> **Who is this for?** Anyone evaluating or onboarding to Founders OS. The demo
> creates temporary memories, walks through each memory feature, then cleans
> everything up.
>
> **How to use it:** Tell your AI agent: *"Read the memory demo script and walk
> me through it."* The agent will read this file and guide you step by step,
> pausing after each scenario for you to continue.

---

## Prerequisites

- **Founders OS v0.8.0 or later.** Call `get_version` and verify the running
  version is at least 0.8.0. If it's older, tell the user they need to rebuild
  and restart the connector first.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** (in this directory),
plus these demo-specific rules:

- **Demo key:** `memory` (run tag is `demorun-memory-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.8.0
- **All memories use the project tag `demorun-memory-<run_id>`.** This makes recall queries
  easy to scope and cleanup reliable. Every `memory_store` and
  `memory_summarize_and_store` call must include `project: "demorun-memory-<run_id>"`.
- **Use org scope for most scenarios.** This shows the conflict/confirmation
  system that protects shared team knowledge. Scenario 1 stores one personal
  memory to show the difference.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Before touching any data, give the user a short orientation

Explain in 3-4 sentences:

- **What they're about to see.** Founders OS has a built-in memory system that
  lets your AI agent remember things across sessions. You can store decisions,
  context, preferences, and session summaries that stay available the next time
  you open a conversation. Memories are searchable by meaning, not just exact
  keywords.
- **How the demo works.** You'll walk through 6 short scenarios covering
  storing, recalling, duplicate detection, updating, forgetting, and
  summarizing. After each one, you'll pause so you can ask questions or move on.
- **Cleanup.** Every memory created during the demo is tagged with a project
  label and will be removed at the end. Nothing permanent.

After the verbal orientation, present a small visual showing how the demo
unfolds - a simple numbered list of the six scenarios:

1. **Store** - Save a memory the team can recall later
2. **Recall** - Find memories by meaning, filtered by scope
3. **Related detection** - Catch a memory that overlaps an existing one
4. **Update** - Revise a shared memory with a before/after preview
5. **Forget** - Remove a memory, with confirmation for shared ones
6. **Summarize** - Capture a whole session as one memory

Don't explain each one in detail. Let the list set expectations and move on.

Keep it conversational - don't read a bulleted list. Then proceed to creating
the seed data.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-memory-<run_id>",
  description: "Ephemeral Memory demo run tag"
}
```

Save the tag ID as `demo_tag_id`. This is the marker used to find and clean up
all demo content.

### 0c. Store a seed memory (org-scoped)

This memory gives Scenario 2 (recall) something to find, and Scenarios 4-5
something to update and delete.

```
Tool: memory_store
Params: {
  content: "We decided to use Stripe for payment processing. The main reasons were developer experience, international coverage, and the ability to handle subscription billing natively. Evaluated against Square and Adyen in April 2026.",
  scope: "org",
  project: "demorun-memory-<run_id>",
  source_tool: "demo"
}
```

Save the returned ID as `seed_memory_id`.

### 0d. Store a second seed memory (personal-scoped)

A personal memory to demonstrate scope filtering in Scenario 2.

```
Tool: memory_store
Params: {
  content: "My preferred format for investor updates: one paragraph on traction, one on product, one on team, then a bullet list of asks. Keep it under 500 words.",
  scope: "personal",
  project: "demorun-memory-<run_id>",
  source_tool: "demo"
}
```

Save the returned ID as `personal_memory_id`.

### 0e. Confirm setup

Tell the user: *"Demo data is ready. I stored two seed memories - one shared
with the team, one personal - and set up a cleanup tag. Ready to start? Say
'next' to begin."*

Render the seed data as a setup summary showing the two memories (with scope
labels) and the cleanup tag.

---

## Scenario 1: Store a Memory

**Feature:** `memory_store`
**What the user sees:** A new memory is stored and the system confirms what was
saved, including its scope and project tag.

### What to tell the user

> "Let's start by storing a memory. This is how your AI agent saves something
> worth remembering across sessions - a decision, a preference, a piece of
> context. You choose whether it's shared with the whole team or just for you."

### Execute

```
Tool: memory_store
Params: {
  content: "Our target customer persona is Series A B2B SaaS founders with 5-20 employees. They care most about reducing operational overhead and keeping their team aligned without adding headcount.",
  scope: "org",
  project: "demorun-memory-<run_id>",
  source_tool: "demo"
}
```

Save the returned ID as `memory_persona_id`.

### Expected result

A successful response with the memory's ID, scope ("org"), project
("demorun-memory-<run_id>"), content, and created_at timestamp.

### What to explain after

> "That memory is now stored and shared with your whole team. Next time anyone
> asks 'who's our target customer?' or 'what persona are we building for?', the
> agent can pull this up - even in a completely different session. The project
> tag helps organize memories by initiative, and the scope controls who can see
> it."

**Pause here.** Wait for the user to continue.

---

## Scenario 2: Recall Memories

**Feature:** `memory_recall`
**What the user sees:** A natural language search that finds relevant memories
by meaning, with scope and project filtering.

### What to tell the user

> "Now let's search for what we know. Memory recall uses semantic search - you
> describe what you're looking for in plain language, and it finds memories by
> meaning, not just keyword matches. Let me show you a few different queries."

### Execute - Step 1: Broad recall

```
Tool: memory_recall
Params: {
  query: "what payment system are we using and why",
  project: "demorun-memory-<run_id>"
}
```

### Expected result

The seed memory about Stripe should come back as the top result with a high
similarity score. The persona memory may also appear with a lower score.

### What to explain after (Step 1)

> "Notice the query was 'what payment system are we using' - but the memory
> says 'Stripe for payment processing.' The search understood the meaning, not
> just the words. Each result has a similarity score so you can see how
> confident the match is."

Render the results showing content previews, scores, and scope labels.

### Execute - Step 2: Scope-filtered recall

```
Tool: memory_recall
Params: {
  query: "how to write investor updates",
  scope: "personal",
  project: "demorun-memory-<run_id>"
}
```

### Expected result

Only the personal memory about investor update format should appear. The
org-scoped memories are filtered out.

### What to explain after (Step 2)

> "This time I searched only personal memories. The investor update format
> showed up because it's yours, but the team-wide Stripe decision was filtered
> out. You can search 'org' for team knowledge, 'personal' for your own notes,
> or 'both' to see everything you have access to."

Render the results with scope labels to highlight the filtering.

**Pause here.** Wait for the user to continue.

---

## Scenario 3: Related Memory Detection

**Feature:** `memory_store` related-memory conflict
**What the user sees:** Trying to store a memory that covers the same ground as
an existing one triggers a suggestion with options.

### What to tell the user

> "What happens if you try to store something the system already knows? Even if
> you phrase it completely differently, the system recognizes the overlap and
> gives you options - update the existing memory, keep both, or skip."

### Execute

```
Tool: memory_store
Params: {
  content: "We chose Stripe as our payment processor because of its developer tools, global reach, and native subscription support. This was decided after comparing with Square and Adyen.",
  scope: "org",
  project: "demorun-memory-<run_id>",
  source_tool: "demo"
}
```

### Expected result

A `conflict` response with type `ambiguous_input`. The system found a related
memory (the seed Stripe memory from Phase 0) and returns:

- The similarity score (should be around 90%)
- A preview of the existing memory
- A preview of the new memory
- Three options: "Update the existing memory with this new version," "Store as
  a separate memory (keep both)," or "Skip - the existing memory is sufficient"

### What to explain after

> "The system recognized that this covers the same ground as an existing memory,
> even though the wording is completely different. It shows both versions so you
> can decide. If the new version is better, update the existing one. If they
> capture different angles, keep both. If it's just a rewording, skip it and
> keep the knowledge base clean."

Present the conflict options and let the user choose. If they choose to update,
the existing memory is replaced. If they store both, save the returned ID as
`memory_duplicate_id` for cleanup. If they skip, note that no new memory was
created.

**Pause here.** Wait for the user to continue.

---

## Scenario 4: Update a Memory

**Feature:** `memory_update`
**What the user sees:** Updating an org-scoped memory shows a before/after
preview for confirmation.

### What to tell the user

> "Decisions change. When you need to update a memory, the system re-indexes
> the content so future searches match the new version. For shared team
> memories, it shows you the change first so you can confirm."

### Execute

```
Tool: memory_update
Params: {
  memory_id: <seed_memory_id>,
  content: "We use Stripe for payment processing. Originally chosen for developer experience, international coverage, and subscription billing. In May 2026 we also enabled Stripe Tax for automated sales tax compliance."
}
```

### Expected result

A `conflict` response with type `destructive_action` showing:

- The before content (original Stripe decision)
- The after content (updated with Stripe Tax addition)
- Two options: "Apply this update" or "Cancel"

### What to explain after

> "Since this is a shared team memory, the system shows the before and after so
> you can review the change. This prevents accidental overwrites - especially
> important when multiple people contribute to the team's knowledge base. Once
> confirmed, the memory is re-indexed so future searches will match the updated
> content."

Present the conflict options and let the user choose. If they confirm, the
memory is updated. If they cancel, the original content stays.

**Pause here.** Wait for the user to continue.

---

## Scenario 5: Forget a Memory

**Feature:** `memory_forget`
**What the user sees:** Deleting an org-scoped memory requires confirmation
with a preview of what's being removed.

### What to tell the user

> "Sometimes a memory is outdated or just wrong. Forgetting removes it
> completely. For shared memories, the system shows you what you're about to
> delete so there are no surprises."

### Execute

Use the personal memory (which deletes immediately without conflict) first,
then try the org-scoped persona memory to show the confirmation flow.

**Step 1: Delete a personal memory (immediate)**

```
Tool: memory_forget
Params: { memory_id: <personal_memory_id> }
```

### Expected result (Step 1)

Immediate deletion - returns `{ deleted: true, memory_id: "..." }`. No
confirmation needed because personal memories only affect you.

### What to explain after (Step 1)

> "Personal memories delete immediately - they're yours, so no confirmation
> needed."

**Step 2: Delete an org-scoped memory (with confirmation)**

```
Tool: memory_forget
Params: { memory_id: <memory_persona_id> }
```

### Expected result (Step 2)

A `conflict` response with type `destructive_action` showing:

- A preview of the memory content
- The project tag and creation date
- Two options: "Yes, delete this memory" or "Cancel"

### What to explain after (Step 2)

> "For shared team memories, the system shows a preview and asks for
> confirmation. This is because deleting org-scoped knowledge affects everyone
> on the team. You get to see exactly what's being removed before committing."

Present the conflict options and let the user choose. Either way, track the
outcome for cleanup.

**Pause here.** Wait for the user to continue.

---

## Scenario 6: Summarize and Store a Session

**Feature:** `memory_summarize_and_store`
**What the user sees:** A longer session narrative is distilled into a memory
entry.

### What to tell the user

> "At the end of a productive session, you might want to capture what happened
> so the next session picks up where you left off. Summarize and store takes a
> full narrative and saves it as a memory. It's like memory_store but designed
> for end-of-session capture."

### Execute

```
Tool: memory_summarize_and_store
Params: {
  session_summary: "Session on May 13, 2026: Reviewed the memory system in Founders OS. Covered all five tools - store, recall, forget, update, and summarize. Key takeaways: semantic search makes recall flexible, duplicate detection keeps the knowledge base clean, and org-scoped memories have confirmation safeguards. Next step is to start using memory in daily workflows to build up project context over time.",
  scope: "org",
  project: "demorun-memory-<run_id>"
}
```

Save the returned ID as `memory_summary_id`.

### Expected result

A successful response with the memory's ID, scope, project, content, and
created_at. The `source_tool` field is automatically set to
`memory_summarize_and_store`.

### What to explain after

> "That session summary is now stored and searchable. The next time someone
> asks 'what did we cover in the memory review session?' the agent can find it.
> This is useful for capturing decisions, action items, and context at the end
> of working sessions so nothing gets lost between conversations."

**Pause here.** Wait for the user to continue.

---

## Summary

Before cleanup, recap what the demo covered:

| # | What happened | What it shows |
|---|---------------|---------------|
| 1 | Stored a team-wide memory about target customers | Memories persist across sessions with scope and project controls |
| 2 | Searched for payment decisions and personal notes | Semantic search finds memories by meaning, scope filtering narrows results |
| 3 | Tried to store a rephrased version of an existing memory | The system recognizes related content and offers to update, keep both, or skip |
| 4 | Updated a shared memory with new information | Org memories show a before/after preview for safe team editing |
| 5 | Deleted a personal and a shared memory | Personal deletes are instant, shared deletes require confirmation |
| 6 | Captured a session summary as a memory | End-of-session capture preserves decisions and context for next time |

Tell the user:

> "That covers the full memory lifecycle - storing knowledge, finding it later,
> keeping it clean, updating it when things change, and removing it when it's
> no longer relevant. The big ideas: memories are searchable by meaning so you
> don't need to remember exact words, duplicate detection keeps the knowledge
> base tidy, and shared memories have safeguards so one person doesn't
> accidentally overwrite or delete team knowledge."

### Ways to ask

Present a visual reference card organized by intent:

**Remember something**
- "Remember that we chose Postgres for the main database"
- "Store a note that the board meeting moved to Thursday"
- "Save this decision for the team"

**What do we know about...**
- "What do we know about our pricing strategy?"
- "Recall any decisions about the tech stack"
- "What did we decide about onboarding?"

**Update what we know**
- "Update the memory about our target market - we're now focusing on Series B"
- "The Stripe decision changed - update that memory"

**Forget something**
- "Forget the old pricing notes"
- "Delete the memory about the beta timeline - it's outdated"

**Capture a session**
- "Summarize what we covered today and save it"
- "Store a summary of this session for next time"

**Search by project or scope**
- "What memories do we have for the founders-os project?"
- "Show me my personal notes"
- "What does the team know about hiring?"

**Pause here.** Ask: *"Ready for cleanup? I'll remove all the demo data now."*

---

## Phase 7: Cleanup

Remove all demo data. Use the IDs saved during setup and scenarios.

### 7a. Delete demo memories

Delete all memories created during the demo by their saved IDs. Delete in
this order:

```
Tool: memory_forget
Params: { memory_id: <memory_summary_id>, resolution: "confirm" }
```

```
Tool: memory_forget
Params: { memory_id: <memory_persona_id>, resolution: "confirm" }
```

Note: `memory_persona_id` may already be deleted if the user confirmed deletion
in Scenario 5. Skip if already gone.

```
Tool: memory_forget
Params: { memory_id: <seed_memory_id>, resolution: "confirm" }
```

```
Tool: memory_forget
Params: { memory_id: <personal_memory_id>, resolution: "confirm" }
```

Note: `personal_memory_id` may already be deleted if Scenario 5 ran. Skip if
already gone.

If the user chose "Store anyway" in Scenario 3 (duplicate detection), also
delete that memory:

```
Tool: memory_forget
Params: { memory_id: <memory_duplicate_id>, resolution: "confirm" }
```

### 7b. Sweep for stragglers

Do a final recall to catch any memories that might have been created during
interactive exploration:

```
Tool: memory_recall
Params: {
  query: "demo memory",
  project: "demorun-memory-<run_id>",
  limit: 50,
  min_score: 0.1
}
```

Delete any remaining memories found.

### 7c. Delete the demo tag

```
Tool: remove_tag
Params: { tag_id: <demo_tag_id>, resolution: "confirm", cascade: true }
```

### 7d. Confirm cleanup

Tell the user:

> "Cleanup complete. I removed all the demo memories and the cleanup tag.
> Your knowledge base is clean."
