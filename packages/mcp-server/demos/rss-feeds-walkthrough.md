---
category: domain
---

# RSS Feeds - Interactive Demo

> **What is this?** A guided walkthrough of the RSS feed tools in Founders OS.
> You'll subscribe to a few feeds, browse the latest headlines, save an
> article for later, and set up a morning briefing - all without leaving
> your AI assistant. Everything created during the demo is cleaned up at
> the end.
>
> **Who is this for?** Anyone who wants to stay on top of industry news,
> competitor updates, or topics that matter to their business - directly
> inside Founders OS instead of a separate feed reader.
>
> **How to use it:** Tell your AI agent: *"Read the RSS feeds demo and walk
> me through it."* The agent will guide you step by step, pausing along
> the way for you to continue.

---

## Prerequisites

- **Founders OS v0.6.0 or later.** RSS feed tools were introduced in v0.6.0.
  Call `get_version` at the start and confirm the running version is >= 0.6.0.
  If it's older, stop and explain.

---

## How to Run This Demo

**Follow all rules in [DEMO_RULES.md](DEMO_RULES.md)** plus these
demo-specific rules:

- **Demo key:** `rss` (run tag is `demorun-rss-<run_id>`; see Run isolation in DEMO_RULES.md)
- **Minimum version:** 0.6.0
- **This demo has two modes.** Scenes 1-3 are agent-led: the agent
  narrates and executes while the user watches. Scenes 4-5 are user-led:
  the agent asks the user to make choices and then carries them out. Make
  this transition feel natural.
- **Live network calls.** RSS feeds require fetching content from the
  internet. If a feed URL fails or times out, acknowledge it naturally
  ("That one seems to be down right now") and move on. Don't let a single
  failed fetch derail the demo.
- **Don't import the starter pack.** This demo subscribes to a small
  handful of specific feeds so cleanup is controlled. Mention that
  `import_starter_feeds` exists for when the user wants to load a full
  curated set after the demo.
- **Feeds touch your real subscriptions.** Feed subscriptions live in a
  per-user table, not behind the run tag, so this demo is careful with
  them. Before subscribing to any feed it checks whether you're already
  subscribed to that exact URL. If you are, the demo reuses your existing
  subscription and never touches it at cleanup - it is yours, not the
  demo's. Only feeds this run actually creates get unsubscribed at the end.
- **Track every created ID.** RSS cleanup relies on the feed IDs and
  bookmark IDs this run created (never tag-based sweeps for feeds, and
  never feeds you already had). Keep a running list throughout, and mark
  each feed as either run-created or pre-existing.
- **Hide the tool names.** Describe actions in plain language: "Let's
  subscribe to that feed" not "I'm going to call subscribe_feed." The
  user should experience the system as a conversation.

---

## The Story

Here's the scenario that ties everything together. The agent should
internalize this and narrate naturally - not read it to the user verbatim.

It's Tuesday morning. You're getting settled for the day and you realize
your news intake is scattered - a tab here, a bookmark there, maybe a
newsletter you forgot to open. You want one place where the important
stuff shows up automatically. Founders OS has a built-in feed reader
that pulls in RSS, Atom, and JSON feeds so your AI assistant can
summarize, search, and surface what matters. Today you're going to set
that up.

---

## Phase 0: Setup - Seed the Demo Data

### 0-intro. Welcome the user

Explain in 3-4 conversational sentences:

- **What they're about to see.** How Founders OS handles RSS feeds -
  subscribing, browsing headlines, bookmarking articles, and getting a
  morning briefing with the latest news.
- **How the demo works.** Five short scenes. The first three are
  agent-led, the last two are hands-on. The whole thing takes about
  five minutes.
- **Cleanup.** Everything created is temporary and gets removed at the
  end.

After the verbal orientation, present a small visual showing the four
feed capabilities as a simple grid. Each capability gets a short label
and a one-line description:

- **Subscribe** - Add any RSS, Atom, or JSON feed by URL
- **Browse** - See the latest headlines across all your feeds
- **Bookmark** - Save articles to read later
- **Briefing** - Get a morning headline digest from your pinned feeds

Then show a few example phrases so the user knows they can just talk
naturally:

- "Subscribe me to Hacker News"
- "What's new in my tech feeds?"
- "Save that article for later"
- "Give me my morning briefing"
- "What have I bookmarked?"

Don't explain each one. Let the list speak for itself.

Then proceed to seeding.

### 0a. Mint the run id

Mint a `run_id` for this run as described in Run isolation (DEMO_RULES.md):
8 characters, lowercase base36, random (for example `k3p9zq4m`). Hold it in
context - every fixture and every cleanup step below uses it.

### 0b. Create the run tag

```
Tool: create_tag
Params: {
  name: "demorun-rss-<run_id>",
  description: "Ephemeral RSS demo run tag"
}
```

Save as `tag_demo_id`. This run tag goes on every feed this run creates, so
those feeds can be told apart from the user's real subscriptions at cleanup.

### 0c. Check existing feeds

Before subscribing to anything, list what the user already has - this is
both an honest demo of the tool against real data and the safety check the
rest of Phase 0 depends on:

```
Tool: list_feeds
Params: {}
```

Each returned feed includes its `url` and `id`. Hold this list in context.
Note the current feed count. If the user already has feeds, mention it
naturally ("You already have a few feeds set up - we'll add some temporary
ones for the demo and clean them up after"). You'll compare against these
URLs before every subscribe below, so you never re-subscribe to (or later
remove) a feed the user already follows.

### 0d. Subscribe to demo feeds

Subscribe to three feeds that cover different content types. These are
chosen because they're reliable and have distinct content. For each one,
**check the `list_feeds` result from 0c before subscribing**:

- **If the user is already subscribed to that exact URL:** do NOT subscribe
  again - it would error with "Already subscribed to this feed." Instead,
  record the existing feed's `id` and mark it **pre-existing**. The demo can
  still read and reference it, but it must NEVER be unsubscribed at cleanup -
  it is the user's real subscription.
- **If the user is NOT subscribed:** subscribe (this run creates it). Include
  the run tag in the feed's `tags` array alongside its classification tag, and
  record the returned feed `id` as **run-created**.

Step 1 - A tech news aggregator (`https://hnrss.org/frontpage`):

If already subscribed, reuse it (pre-existing) and skip the call. Otherwise:

```
Tool: subscribe_feed
Params: {
  url: "https://hnrss.org/frontpage",
  tags: ["tech", "demorun-rss-<run_id>"],
  pinned: true
}
```

Save the feed id as `feed_hn_id` and mark whether it is run-created or
pre-existing. Note: only pin a run-created feed here. If this URL is a
pre-existing subscription, leave its pinned state exactly as the user has
it - don't pin it on their behalf.

Step 2 - A science/space feed (`https://www.nasa.gov/rss/dyn/breaking_news.rss`):

If already subscribed, reuse it (pre-existing) and skip the call. Otherwise:

```
Tool: subscribe_feed
Params: {
  url: "https://www.nasa.gov/rss/dyn/breaking_news.rss",
  tags: ["science", "demorun-rss-<run_id>"],
  pinned: false
}
```

Save the feed id as `feed_nasa_id` and mark run-created or pre-existing.

Step 3 - A webcomic with short, fun items (good for showing
content variety) (`https://xkcd.com/rss.xml`):

If already subscribed, reuse it (pre-existing) and skip the call. Otherwise:

```
Tool: subscribe_feed
Params: {
  url: "https://xkcd.com/rss.xml",
  tags: ["fun", "demorun-rss-<run_id>"],
  pinned: false
}
```

Save the feed id as `feed_xkcd_id` and mark run-created or pre-existing.

If any subscription fails because the URL is unreachable, acknowledge it and
continue with the ones that worked. The demo needs at least two feeds to be
meaningful. (Reusing a pre-existing subscription is not a failure - it just
means that feed is the user's, so the demo borrows it without owning it.)

### 0e. Confirm setup

Present a visual summary of the feeds for the demo: their names, tags, and
pinned status, and for each whether it is a temporary feed this run added or
one the user already had. Then tell the user the stage is set (the feeds this
run created carry the run tag so they can be removed cleanly, and any feed
they already followed stays untouched) and prompt them to say "next" or
"continue" to begin.

**Pause here.**

---

## Scene 1: What's Out There - "Show me the headlines"

**What the user sees:** A stream of recent headlines from the feeds
they just subscribed to, organized and browsable.

### What to tell the user

> "Now that you have some feeds set up, let's see what's out there.
> In Founders OS you can just say 'what's new?' and the system pulls
> the latest headlines from all your subscribed feeds. Let me grab
> the most recent ones."

### Execute

**Important:** If the user already has many feeds (20+), fetching
across all feeds at once can time out. Fetch each demo feed
individually instead, then combine the results for presentation.

```
Tool: get_feed_items
Params: {
  feed_id: <feed_hn_id>,
  limit: 5
}
```

```
Tool: get_feed_items
Params: {
  feed_id: <feed_nasa_id>,
  limit: 5
}
```

```
Tool: get_feed_items
Params: {
  feed_id: <feed_xkcd_id>,
  limit: 5
}
```

These can be called in parallel. Combine the results and sort by
date for presentation.

### Expected result

A list of items with titles, authors, dates, and source feeds. Items
come from all three subscribed feeds, sorted newest first. Each item
has an index number and a flag indicating whether full content is
available.

### What to explain after

Present the combined headlines visually as a single list. Each row
should show the item number, title, source feed name, and how recent
it is. Badge by source feed to show the variety.

> "These are the latest headlines across your demo feeds. Each one has
> a number - you can pick any of them to read the full article. You
> can also filter by topic. Let me show you what that looks like."

Now demonstrate filtering by tag. Use the `tag` parameter on a
single feed to keep it fast:

```
Tool: get_feed_items
Params: {
  tag: "science",
  limit: 5
}
```

Present the filtered results visually, noting that only
science-tagged items appear.

> "See how you can narrow it down? Just say 'show me science news' or
> 'what's new in tech' and the system filters by tag. You can also
> look at a single feed if you want to focus."

**Pause here.**

---

## Scene 2: Dive Deeper - "Read that one"

**What the user sees:** The full content of a feed item, pulled
directly from the RSS feed.

### What to tell the user

> "Headlines are useful for scanning, but sometimes you want the full
> story. Let's pick one and read it."

### Execute

Choose an item from the previous results that has `has_full_content:
true`. If none do, pick the first item regardless - the tool will
return a summary and link instead.

Note: use the `feed_url` and `index` from the item you're reading.

```
Tool: read_feed_item
Params: {
  feed_url: <url of the feed the item came from>,
  item_index: <index of the chosen item>
}
```

### Expected result

Either full article content (HTML) or a summary with a link to the
original. The response includes title, author, date, and content type.

### What to explain after

Present the article content in a clean, readable format. If full
content was available, show a formatted excerpt. If only a summary
came back, show the summary and mention the link.

> "That's the full article, right here in the conversation. Some feeds
> include the complete text, others just give you a summary with a link.
> Either way, you don't have to leave to read it."

Transition naturally:

> "Now let's say this is something you want to come back to later. You
> can bookmark it so it's saved even after the feed updates with new
> items."

**Pause here.**

---

## Scene 3: Save It - "Bookmark that"

**What the user sees:** An article being bookmarked, then the bookmark
list showing saved items.

### What to tell the user

> "Feed items are live - they come and go as the feed updates. But if
> you find something worth keeping, you can bookmark it. The system
> saves a snapshot of the article so it's always there, even if the
> feed drops it later. Let me save that article we just read."

### Execute

Step 1 - Bookmark the item from Scene 2:

```
Tool: bookmark_item
Params: {
  feed_url: <same feed_url from Scene 2>,
  item_index: <same item_index from Scene 2>
}
```

Save as `bookmark_1_id`.

Step 2 - Show the bookmark list:

```
Tool: list_bookmarks
Params: {}
```

### Expected result

The bookmark is created with a confirmation message. The bookmark list
shows the saved item with its title, source, and when it was saved.

### What to explain after

Present the bookmark list visually. Show each bookmarked item with its
title, source feed, and save date.

> "There it is - saved. Your bookmarks persist across sessions, so you
> can come back tomorrow and ask 'what have I bookmarked?' and it's all
> right there. You can save as many as you want."

Transition to the hands-on portion:

> "Now it's your turn. Let's set up your morning briefing - that's the
> headline digest that shows up when you start your day."

**Pause here.**

---

## Scene 4: Your Turn - "Set up the briefing"

**What the user sees:** The user chooses which feeds to pin for the
morning briefing, then sees the briefing in action.

### What to tell the user

> "Founders OS has a morning briefing that pulls one headline from each
> of your pinned feeds. Right now, only one of our demo feeds is pinned.
> Which of the other two would you like to add to the briefing?"

### Execute

Present the user with the unpinned demo feeds and let them choose.
Show each feed's name and what it covers:

- **NASA Breaking News** - Space and science updates
- **xkcd** - The webcomic (a lighter touch for the morning)

The user can pick one, both, or neither. Whatever they choose:

```
Tool: pin_feed
Params: {
  feed_id: <chosen feed ID>
}
```

Save any newly pinned feed IDs so you can unpin them during cleanup.

Once pinning is done, show the briefing:

```
Tool: get_feed_briefing
Params: {
  max_headlines: 6
}
```

### Expected result

The briefing returns one headline per tag from pinned feeds, capped at
the max. Each headline includes the title, source feed, tag, and link.

### What to explain after

Present the briefing visually as a compact headline card - each row
showing the tag badge, headline title, and source feed. This is the
format that appears in the morning check-in.

> "That's your morning briefing - one headline per topic from your
> pinned feeds. When you start your day and say 'catch me up,' this
> is part of what shows up. You can pin and unpin feeds anytime to
> control what appears here."

**Pause here.**

---

## Scene 5: Your Turn - "Add your own feed"

**What the user sees:** The user subscribes to a feed of their choice,
browses its items, and optionally bookmarks one.

### What to tell the user

> "Last thing - let's add a feed that actually matters to you. Is there
> a blog, news site, or newsletter you follow? If you have the RSS URL,
> I can subscribe to it right now. If you're not sure of the URL, just
> tell me the site name and I'll try to find it."

### Execute

Present some ideas but make it clear the user can pick anything:

- A competitor's blog
- An industry publication
- A favorite tech blog or newsletter
- A subreddit (Reddit has RSS: `https://www.reddit.com/r/<name>/.rss`)

The user may give a site name instead of a URL. If so, search the
web for the site and find the RSS feed URL. Different platforms put
their feeds in different places:

- **Ghost sites:** `/rss/`
- **Beehiiv newsletters:** look for `rss.beehiiv.com/feeds/...` in
  the page footer or HTML source
- **Substack:** `/feed`
- **WordPress:** `/feed/` or `/rss/`
- **Medium:** `/feed`
- **Reddit:** append `/.rss` to any subreddit URL

Before subscribing, check the user's current subscriptions (the `list_feeds`
result you already hold, refreshed if needed) for this exact URL:

- **If the user is already subscribed:** don't subscribe again - it would
  error. Tell them they already follow this one, reuse the existing feed `id`
  as `feed_custom_id`, and mark it **pre-existing** so cleanup leaves it
  alone. They can still browse and bookmark from it below.
- **If the user is NOT subscribed:** subscribe (this run creates it) and
  include the run tag alongside the content tag.

Once you have the right URL and have confirmed it's not already subscribed:

```
Tool: subscribe_feed
Params: {
  url: <user's chosen URL>,
  tags: [<a tag suggested from the content>, "demorun-rss-<run_id>"],
  pinned: false
}
```

Save as `feed_custom_id` and mark it run-created.

If the first URL you try subscribes successfully but returns zero
items, check the site for the actual feed URL - many newsletter
platforms (especially Beehiiv) host their RSS at a different domain
than the site itself. Unsubscribe from the empty one (it's run-created, so
removing it is safe) and try the correct URL, applying the same
already-subscribed check before the retry.

If the subscription succeeds, immediately pull items:

```
Tool: get_feed_items
Params: {
  feed_id: <feed_custom_id>
}
```

If items come back empty, try `refresh_feeds` with the feed_id. If
still empty, the URL is likely wrong - check the site for the real
feed URL as described above.

Present the headlines and ask if they'd like to bookmark any of them
or pin the feed for their morning briefing.

If the user wants to bookmark:

```
Tool: bookmark_item
Params: {
  feed_url: <custom feed URL>,
  item_index: <chosen index>
}
```

Save as `bookmark_2_id` (if created).

If the user wants to pin (only pin a run-created feed; if `feed_custom_id`
is a pre-existing subscription, leave its pinned state as the user has it):

```
Tool: pin_feed
Params: {
  feed_id: <feed_custom_id>
}
```

### Expected result

A feed subscribed (or an existing one reused), items displayed, and
optionally a bookmark or pin created. The user experiences the full flow
with content they actually care about.

### What to explain after

> "That's the complete workflow - subscribe, browse, bookmark, pin.
> Once you're done with the demo, you can keep that feed if you want
> or I'll remove it during cleanup. Just let me know."

If this feed was run-created, ask the user whether they'd like to keep it
or remove it with the rest of the demo data, and save their preference for
cleanup. If it was a pre-existing subscription, there's nothing to decide -
it's already theirs and cleanup will leave it untouched.

**Pause here.**

---

## Summary

### What to tell the user

> "That's your RSS setup in Founders OS. In a few minutes you subscribed
> to feeds, browsed headlines, read a full article, bookmarked it for
> later, and set up a morning briefing - all without leaving the
> conversation. And everything you did, you could have done by just
> asking naturally."

### Offer to keep the feeds

Before moving to cleanup, ask the user which of the **run-created** feeds
they'd like to keep. Only feeds this run added are in play here - any feed
the user was already subscribed to stays no matter what, so don't offer to
remove it. Present the run-created feeds (plus any custom feed from Scene 5
that this run created) and let the user pick any combination - all, some,
or none.

> "Before I clean up, these feeds are actually pretty useful day-to-day.
> Would you like to keep any of them?"

Present the run-created feeds with a short reminder of what each one covers,
for example:

- **Hacker News** - Tech news and discussion (currently pinned)
- **NASA Breaking News** - Space and science updates
- **xkcd** - The webcomic
- Plus the custom feed from Scene 5, if this run added one

(If any of the above turned out to be a feed the user already followed, leave
it off this list - it was never the demo's to remove.)

The user can keep all of the run-created feeds, pick specific ones, or remove
everything the run added. Save their choices - the cleanup phase will skip
any feeds the user wants to keep, and always skips pre-existing subscriptions.

If the user keeps any feeds, strip the run tag from them so they look like
regular subscriptions, and mention that their pinned status and other tags
will stay as-is and they can adjust those anytime.

### Ways to ask

Present a visual reference card organized by intent. Each row has a
short intent label and 2-3 example phrases:

**Stay current**
- "What's new?"
- "Show me today's tech headlines"
- "Anything interesting in my feeds?"

**Go deeper**
- "Read that Hacker News article about compilers"
- "What's the full story on item 3?"
- "Summarize the top 5 science articles"

**Save for later**
- "Bookmark that one"
- "What have I bookmarked?"
- "Remove the bookmark on that old article"

**Morning briefing**
- "Catch me up"
- "Give me my morning briefing"
- "Pin the NASA feed to my briefing"

**Manage feeds**
- "Subscribe me to the Pragmatic Engineer blog"
- "What feeds am I subscribed to?"
- "Unsubscribe from xkcd"
- "Load the starter feed pack"

### What's next

> "If you want a bigger set of feeds to start with, just say 'import
> the starter feeds' and the system will load a curated pack covering
> tech, AI, business, engineering, crypto, and news. Some of those
> come pre-pinned for the morning briefing. Ready for cleanup?"

**Pause here.** Wait for the user to confirm before cleaning up.

---

## Phase 6: Cleanup

Clean up only what this run created. Two rules govern this entire phase:

1. **Only remove run-created feeds.** Never unsubscribe a feed marked
   pre-existing - that is the user's real subscription. The server-side
   reaper does not currently reap feed subscriptions, so this in-session
   guarded cleanup is the only thing that removes run-created feeds.
   Protecting the user's real subscriptions takes priority over tidiness:
   if you are ever in doubt whether the run created a feed, do NOT
   unsubscribe it.
2. **Honor the keep choices.** The user may have chosen to keep some or all
   of the run-created feeds in the Summary step - only remove the run-created
   ones they didn't keep.

### Step 1: Remove bookmarks

Remove bookmarks only for run-created feeds the user chose to remove. If a
feed is being kept (or was pre-existing), the bookmarks from it stay too.

For each run-created feed the user is NOT keeping:

```
Tool: remove_bookmark
Params: {
  bookmark_id: <bookmark_1_id>
}
```

If `bookmark_2_id` exists and it came from a run-created feed the user is
removing:

```
Tool: remove_bookmark
Params: {
  bookmark_id: <bookmark_2_id>
}
```

(If a bookmark was made against a pre-existing feed, leave it - it is the
user's, not the demo's.)

### Step 2: Unsubscribe from run-created feeds the user doesn't want

Unsubscribe ONLY feed ids this run created. Skip every pre-existing
subscription, and skip any run-created feed the user chose to keep.
`unsubscribe_feed` removes only the caller's own subscription, so this never
touches teammates - but the guard above is what keeps it from touching the
user's own real feeds.

For each run-created feed the user is NOT keeping:

```
Tool: unsubscribe_feed
Params: {
  feed_id: <feed_id>
}
```

If the user is keeping any run-created feeds, strip the run tag
(`demorun-rss-<run_id>`) from them so they look like regular subscriptions.
(The run tag was only there to mark them as this run's creation.)

### Step 3: Sweep for straggler bookmarks

```
Tool: list_bookmarks
Params: {}
```

Check if any bookmarks remain from run-created feeds that were removed. If
so, remove them. Leave bookmarks for kept feeds and pre-existing feeds alone.

### Step 4: Delete the run tag

```
Tool: remove_tag
Params: {
  tag_id: <tag_demo_id>,
  resolution: "confirm",
  cascade: true
}
```

### Confirm cleanup

Tailor the message based on what the user kept:

If the user kept all feeds:

> "All done - the demo scaffolding is cleaned up but your feeds are
> still active. You'll see headlines from them next time you check in."

If the user kept some feeds:

> "All done - I removed the feeds you didn't want and kept the ones
> you did. They're part of your regular setup now."

If the user removed everything this run added:

> "All done - the feeds and bookmarks this demo created have been removed,
> and anything you already followed is untouched. If you'd like to get
> started for real, just say 'import the starter feeds' and you'll have a
> full curated set ready to go."
