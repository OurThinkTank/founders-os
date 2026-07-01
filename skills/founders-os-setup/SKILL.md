---
name: founders-os-setup
description: Guide a user through turning on Founders OS proactive agents - scheduling the overnight check, connecting Slack, and enabling unattended sending. Use when the user says things like "set me up to run automatically", "schedule my watches", "run in the background", "check every morning on its own", "turn on proactive agents", "connect Slack for the runner", or "let it send on its own". Always drives the founders-os-tick CLI; never hand-writes scheduler files.
---

# Founders OS setup (conversational face)

Your job is to walk a non-technical founder through setup by driving the `founders-os-tick` CLI. You NEVER hand-author launchd/systemd/cron/Task Scheduler files or edit config by hand - the CLI does all of that. You just choose the right command, explain it in plain language, and either run it (only if your shell is the user's own machine) or hand it over.

## The four commands (this is the whole surface)

- `founders-os-tick init` - schedules the overnight check. Safe: it wires `detect` + `run --hold-only`, so it prepares and stages items, and sends nothing. Flags: `--yes` (accept defaults: hourly, OS default scheduler), `--daily`, `--hour=N`, `--cron`, `--tick-bin=...`.
- `founders-os-tick doctor` - shows status: is the schedule registered, last run, auto-send on/off, model, connector. Use it to verify.
- `founders-os-tick connect slack` - mints one durable token so the runner can post as the user. Stays stage-first (nothing sends). Interactive: needs a browser and a pasted token.
- `founders-os-tick autosend slack --on|--off` - turns unattended sending on or off (flips the external-write policy). Deliberate, reversible.

## Step 1: figure out WHERE your shell runs (this decides everything)

- If your shell (bash) runs on the user's OWN computer - for example Claude Code running natively on their machine - you can run `init`/`doctor`/`autosend` for them directly.
- If your shell is an ISOLATED sandbox (for example Cowork's Linux workspace), it is a different machine from the user's. You CANNOT register a scheduler on their computer from there. Hand the commands over for them to run in their own terminal (or, if you have computer-use access to their desktop, open their Terminal and run it there).
- If you have no shell at all (a plain MCP chat client), hand the commands over.

When in doubt, hand over. It is always correct; running blindly on the wrong machine is not.

## Step 2: schedule the overnight check

Explain first, in one or two sentences: "This sets up an hourly check that prepares anything needing you and leaves it in your inbox. It never sends anything on its own."

Run-it-for-them path (shell is the user's machine): the check needs Supabase credentials. If they are already in the environment, run:

```
founders-os-tick init --yes
```

If not, gather the Supabase URL and secret key (from the user or their existing Founders OS config) and pass them inline rather than making them edit files:

```
SUPABASE_URL=... SUPABASE_SECRET_KEY=... founders-os-tick init --yes
```

Then run `founders-os-tick doctor` and report the result in plain language.

Hand-over path (sandbox / no shell): give them exactly one line to paste, no install step to think about:

```
npx -y -p @ourthinktank/founders-os@latest founders-os-tick init
```

Tell them it will ask a couple of questions (how often, that's it) and that nothing is sent. Then have them run `... founders-os-tick doctor` to confirm.

## Step 3: connect Slack (ALWAYS user-run)

`connect slack` is interactive - it opens a browser to create the Slack app and asks the user to paste their token. You cannot do the browser step or paste the token for them, even with a shell. So this is always a hand-over:

```
founders-os-tick connect slack
```

Walk them through what it does: opens a prefilled Slack app page (click Create, toggle on the Slack MCP Server under Agents and AI Apps, Install), then paste the User OAuth Token when asked, then tick the channels the runner may post to. Reassure them: connecting does NOT turn on sending - messages are prepared and held for their approval. If their workspace needs admin approval to install, that is a one-time request Slack shows them; the admin never sees their token.

## Step 4: turn on auto-send (only when they ask, with the floor)

Only when the user explicitly wants low-risk messages to post on their own:

```
founders-os-tick autosend slack --on
```

Always state the floor in plain words: "Low-risk messages can post on their own. Anything carrying a contact email, a secret, or a dollar figure is still held for you - that can't be turned off. Reverse anytime with `--off`." If you have a shell on their machine you may run it, but let them confirm first; the command itself also asks for confirmation.

## Always include this framing

- Setup is safe by default: the schedule only prepares and stages; nothing sends until they deliberately turn on auto-send.
- Even with auto-send on, sensitive content (emails, secrets, money) is always held for a human.
- To pause everything, they can ask Founders OS to pause the agents in a session.

## Never do this

- Never hand-write or edit a launchd plist, systemd unit, cron line, Task Scheduler task, or the env/policy/connector files. The CLI owns all of them.
- Never run `init` in a sandbox shell and imply it set up their real machine - it did not.
- Never paste a Slack token you were given into a command; the user pastes their own token into `connect slack`.
- Never turn on auto-send as a side effect of anything else; it is only ever an explicit, confirmed step.
