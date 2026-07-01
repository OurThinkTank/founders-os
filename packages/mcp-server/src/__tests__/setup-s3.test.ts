// Pure-logic + mocked-client tests for S3 (connect slack + autosend). No
// network: the Slack client takes an injected fetch.

import { describe, it, expect } from "vitest";
import { buildCreateFromManifestUrl, FOUNDERS_OS_SLACK_MANIFEST, SLACK_USER_SCOPES } from "../setup/slack-manifest.js";
import { SlackClient, type FetchLike, type HttpResponse } from "../setup/slack-client.js";
import { validateUserToken, buildConnectorsConfig, buildSlackPolicy, selectChannels } from "../setup/connect-slack.js";
import { buildAutosendPatch } from "../setup/autosend.js";
import { buildEnvFile, parseEnvFile } from "../setup/generators.js";
import type { SlackChannel } from "../setup/slack-client.js";

function mockFetch(data: unknown, capture?: (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => void): FetchLike {
  return async (url, init) => {
    capture?.(url, init);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as HttpResponse;
  };
}

describe("slack manifest URL", () => {
  it("round-trips the manifest through the create-from-manifest URL", () => {
    const url = buildCreateFromManifestUrl();
    expect(url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json=")).toBe(true);
    const encoded = url.split("manifest_json=")[1];
    const manifest = JSON.parse(decodeURIComponent(encoded));
    expect(manifest).toEqual(FOUNDERS_OS_SLACK_MANIFEST);
    expect(manifest.oauth_config.scopes.user).toEqual([...SLACK_USER_SCOPES]);
    expect(manifest.oauth_config.scopes.user).toContain("chat:write");
  });
});

describe("SlackClient (mocked fetch)", () => {
  it("authTest reads identity and sends a Bearer token", async () => {
    let seen: { headers?: Record<string, string>; method?: string } | undefined;
    const client = new SlackClient("xoxp-abc", mockFetch({ ok: true, user: "Vince", team: "OTT", user_id: "U1", team_id: "T1" }, (_u, i) => (seen = i)));
    const r = await client.authTest();
    expect(r).toMatchObject({ ok: true, user: "Vince", team: "OTT" });
    expect(seen?.method).toBe("POST");
    expect(seen?.headers?.Authorization).toBe("Bearer xoxp-abc");
  });

  it("authTest surfaces an error", async () => {
    const client = new SlackClient("xoxp-bad", mockFetch({ ok: false, error: "invalid_auth" }));
    expect(await client.authTest()).toMatchObject({ ok: false, error: "invalid_auth" });
  });

  it("listMemberChannels maps id + name", async () => {
    const client = new SlackClient("xoxp-abc", mockFetch({ ok: true, channels: [{ id: "C1", name: "ops" }, { id: "C2", name: "founders-os" }] }));
    const r = await client.listMemberChannels();
    expect(r.ok).toBe(true);
    expect(r.channels).toEqual([{ id: "C1", name: "ops" }, { id: "C2", name: "founders-os" }]);
  });

  it("postMessage passes channel + text in the body", async () => {
    let seen: { body?: string } | undefined;
    const client = new SlackClient("xoxp-abc", mockFetch({ ok: true, ts: "1.2" }, (_u, i) => (seen = i)));
    const r = await client.postMessage("C1", "hello there");
    expect(r).toMatchObject({ ok: true, ts: "1.2" });
    expect(seen?.body).toContain("channel=C1");
    expect(seen?.body).toContain("hello+there");
  });
});

describe("connect-slack pure helpers", () => {
  it("validateUserToken accepts xoxp, rejects xoxb/empty/other", () => {
    expect(validateUserToken("xoxp-123").ok).toBe(true);
    expect(validateUserToken("  xoxp-123  ").ok).toBe(true);
    expect(validateUserToken("xoxb-123")).toMatchObject({ ok: false });
    expect(validateUserToken("")).toMatchObject({ ok: false });
    expect(validateUserToken("nope")).toMatchObject({ ok: false });
  });

  it("buildConnectorsConfig puts the token in the mcp.slack.com bearer, nowhere else", () => {
    const cfg = buildConnectorsConfig("xoxp-secret") as { mcpServers: { slack: { url: string; headers: { Authorization: string } } } };
    expect(cfg.mcpServers.slack.url).toBe("https://mcp.slack.com/mcp");
    expect(cfg.mcpServers.slack.headers.Authorization).toBe("Bearer xoxp-secret");
  });

  it("buildSlackPolicy is stage-first shaped with the chosen channels", () => {
    const p = buildSlackPolicy(["C1", "C2"]) as { slack: { actions: string[]; scopeField: string; scopes: string[] } };
    expect(p.slack.actions).toEqual(["slack_send_message", "slack_schedule_message"]);
    expect(p.slack.scopeField).toBe("channel_id");
    expect(p.slack.scopes).toEqual(["C1", "C2"]);
  });

  it("selectChannels parses numbers and 'all'", () => {
    const chans: SlackChannel[] = [{ id: "C1", name: "a" }, { id: "C2", name: "b" }, { id: "C3", name: "c" }];
    expect(selectChannels("1,3", chans).map((c) => c.id)).toEqual(["C1", "C3"]);
    expect(selectChannels("all", chans)).toHaveLength(3);
    expect(selectChannels("9,x", chans)).toEqual([]); // out of range / junk ignored
  });
});

describe("autosend patch", () => {
  it("--on raises external_write to allow_with_log; --off restores hold", () => {
    expect(buildAutosendPatch(true)).toEqual({ tier_outcomes: { external_write: "allow_with_log" } });
    expect(buildAutosendPatch(false)).toEqual({ tier_outcomes: { external_write: "hold_for_approval" } });
  });
});

describe("env file round-trip (connect merges into it)", () => {
  it("parseEnvFile recovers keys buildEnvFile wrote, including a quoted value", () => {
    const text = buildEnvFile({ SUPABASE_URL: "https://x.co", FOUNDERSOS_TICK_BIN: "npx -y -p pkg tick" });
    const map = parseEnvFile(text);
    expect(map.SUPABASE_URL).toBe("https://x.co");
    expect(map.FOUNDERSOS_TICK_BIN).toBe("npx -y -p pkg tick");
  });
});
