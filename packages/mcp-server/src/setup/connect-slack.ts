// ============================================================
// Founders OS — `founders-os-tick connect slack`
// ============================================================
// Mints one durable user token for the unattended runner and writes the two
// files the runner reads: runner-connectors.json (the credential) and
// connector-policy.json (which verbs/channels the hook clears). Connecting
// stays STAGE-FIRST: it never enables auto-send. See
// proposals/connect-slack-flow-detailed.md.
// ============================================================

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { managedPaths } from "./paths.js";
import { makePrompter } from "./prompt.js";
import { buildEnvFile, parseEnvFile } from "./generators.js";
import { buildCreateFromManifestUrl, FOUNDERS_OS_SLACK_MANIFEST } from "./slack-manifest.js";
import { SlackClient, type SlackChannel } from "./slack-client.js";

const EXIT_OK = 0;
const EXIT_FAIL = 1;

export interface ConnectArgs {
  connector: string; // positional, e.g. "slack"
}

// ── Pure helpers (unit-tested) ──────────────────────────────

/** A durable unattended credential must be a USER token (xoxp-), not a bot
 * token (xoxb-). Catch the wrong paste here, not at 3am. */
export function validateUserToken(raw: string): { ok: boolean; error?: string } {
  const t = raw.trim();
  if (!t) return { ok: false, error: "no token entered" };
  if (t.startsWith("xoxb-")) return { ok: false, error: "that's a bot token (xoxb-); paste the User OAuth Token (xoxp-...)" };
  if (!t.startsWith("xoxp-")) return { ok: false, error: "that doesn't look like a Slack user token (should start with xoxp-)" };
  return { ok: true };
}

/** The runner-connectors.json the Agent SDK runner reads. The token lives
 * ONLY here; founders-os core never reads this file. */
export function buildConnectorsConfig(token: string): unknown {
  return {
    mcpServers: {
      slack: {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        headers: { Authorization: `Bearer ${token.trim()}` },
      },
    },
  };
}

/** The connector-policy.json: which verbs + channels the hook will clear.
 * Stage-first — the policy tier stays hold until `autosend --on`. */
export function buildSlackPolicy(channelIds: string[]): unknown {
  return {
    slack: {
      actions: ["slack_send_message", "slack_schedule_message"],
      scopeField: "channel_id",
      scopes: channelIds,
    },
  };
}

/** Parse a channel-picker answer ("1,3" or "all") into selected ids. */
export function selectChannels(answer: string, channels: SlackChannel[]): SlackChannel[] {
  const a = answer.trim().toLowerCase();
  if (a === "all") return channels;
  const idx = new Set(
    a
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= channels.length)
      .map((n) => n - 1)
  );
  return channels.filter((_, i) => idx.has(i));
}

// ── IO helpers ──────────────────────────────────────────────

function write600(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort; the URL is also printed */
  }
}

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

// ── Orchestrator ────────────────────────────────────────────

export async function runConnectSlack(a: ConnectArgs): Promise<number> {
  if (a.connector && a.connector !== "slack") {
    err(`[connect] only "slack" is supported right now (got "${a.connector}").`);
    return EXIT_FAIL;
  }
  if (!process.stdin.isTTY) {
    err("[connect] connect slack is interactive (it needs you to paste a token and pick channels). Run it in a terminal.");
    return EXIT_FAIL;
  }

  const paths = managedPaths();
  if (!existsSync(paths.envFile)) {
    err("[connect] run `founders-os-tick init` first so the schedule and credentials exist, then connect Slack.");
    return EXIT_FAIL;
  }

  const prompter = makePrompter();
  try {
    if (existsSync(paths.connectorsFile)) {
      const go = await prompter.confirm("Slack is already connected. Reconnect and overwrite the token?", false);
      if (!go) return EXIT_OK;
    }

    // ── 1. Create the app (prefilled manifest) ──
    const url = buildCreateFromManifestUrl(FOUNDERS_OS_SLACK_MANIFEST);
    out("Connect Slack — so the overnight runner can post updates you approve.\n");
    out("1) I'll open Slack's app-creation page with everything prefilled. Click Create,");
    out("   then under 'Agents & AI Apps' toggle on the Slack MCP Server, then Install to Workspace.");
    out("   If your workspace needs admin approval, submit the request Slack shows — it's a one-time,");
    out("   workspace-wide approval; the admin never sees your token. You can re-run this after.\n");
    out("   " + url + "\n");
    openInBrowser(url);
    await prompter.ask("Press Enter once the app is installed and you can see the User OAuth Token");

    // ── 2. Capture + validate the token ──
    const token = (await prompter.ask("Paste the User OAuth Token (xoxp-...)")).trim();
    const shape = validateUserToken(token);
    if (!shape.ok) {
      err(`[connect] ${shape.error}`);
      return EXIT_FAIL;
    }
    const client = new SlackClient(token);
    const auth = await client.authTest();
    if (!auth.ok) {
      err(`[connect] Slack rejected the token: ${auth.error ?? "unknown error"}. If approval is pending, try again once it's approved.`);
      return EXIT_FAIL;
    }
    out(`✓ Token works — signed in as ${auth.user ?? "you"} at ${auth.team ?? "your workspace"}. It won't expire.`);

    mkdirSync(paths.configDir, { recursive: true });
    write600(paths.connectorsFile, JSON.stringify(buildConnectorsConfig(token), null, 2) + "\n");

    // ── 3. Pick channels, write the policy (stage-first) ──
    const list = await client.listMemberChannels();
    if (!list.ok) {
      err(`[connect] could not list your channels: ${list.error ?? "unknown error"} (need channels:read/groups:read). The token is saved; re-run to pick channels.`);
      return EXIT_FAIL;
    }
    let selected: SlackChannel[] = [];
    if (list.channels.length === 0) {
      out("You're not in any channels the app can see yet. Add the app to a channel, then re-run to pick.");
    } else {
      out("\nWhich channels may the runner post to?");
      list.channels.forEach((c, i) => out(`  ${i + 1}) #${c.name}`));
      const ans = await prompter.ask("Enter numbers (comma-separated) or 'all'", "");
      selected = selectChannels(ans, list.channels);
    }
    write600(paths.policyFile, JSON.stringify(buildSlackPolicy(selected.map((c) => c.id)), null, 2) + "\n");
    out(`✓ Saved. The runner may PREPARE Slack messages${selected.length ? " for " + selected.map((c) => "#" + c.name).join(", ") : ""} — held for your approval. Nothing sends on its own.`);

    // ── 4. Point the env file at both files ──
    const envMap = parseEnvFile(readFileSync(paths.envFile, "utf-8"));
    envMap.FOUNDERSOS_RUNNER_CONNECTORS = paths.connectorsFile;
    envMap.FOUNDERSOS_CONNECTOR_POLICY_FILE = paths.policyFile;
    write600(paths.envFile, buildEnvFile(envMap));

    // ── 5. Optional connectivity test send ──
    if (selected.length > 0) {
      const doTest = await prompter.confirm(`Post a quick "Founders OS is connected" test to #${selected[0].name} now?`, false);
      if (doTest) {
        const r = await client.postMessage(selected[0].id, "Founders OS is connected ✅ (setup test — you can ignore this).");
        if (r.ok) out(`✓ Posted to #${selected[0].name} — you should see it land in Slack.`);
        else err(`[connect] test send failed: ${r.error ?? "unknown error"} (the app may need to be added to that channel).`);
      }
    }

    out('\nDone. Slack is connected and stage-first. When you want low-risk messages to post on their own:');
    out("  founders-os-tick autosend slack --on");
    out("  (Anything with a contact email, a secret, or a dollar figure is always held for you.)");
    return EXIT_OK;
  } finally {
    prompter.close();
  }
}
