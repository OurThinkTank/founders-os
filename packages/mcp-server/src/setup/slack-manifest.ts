// ============================================================
// Founders OS — Slack app manifest + create-from-manifest URL
// ============================================================
// `connect slack` mints ONE durable user token for the unattended runner.
// The first step is creating a Slack app; a prefilled manifest URL reduces
// that to a click (the user assembles nothing). See
// proposals/connect-slack-flow-detailed.md.
//
// Scopes are USER-token scopes (the Slack MCP send tools use the user token):
//   chat:write     — post messages as the user (the whole point)
//   channels:read  — list public channels the user is in (for the picker)
//   groups:read    — same for private channels
// Token rotation is left at Slack's default (OFF) so the xoxp token is
// durable; enabling rotation is opt-in and irreversible, so we simply never
// turn it on. The "Slack MCP server" feature toggle (Agents & AI Apps) is a
// one-time UI step after creation — it is not reliably settable via manifest,
// so the flow instructs it rather than pretending the manifest does it.
// ============================================================

export interface SlackManifest {
  display_information: { name: string; description?: string };
  oauth_config: { scopes: { user: string[] } };
}

export const SLACK_USER_SCOPES = ["chat:write", "channels:read", "groups:read"] as const;

export const FOUNDERS_OS_SLACK_MANIFEST: SlackManifest = {
  display_information: {
    name: "Founders OS",
    description: "Prepares and sends the updates you approve.",
  },
  oauth_config: {
    scopes: { user: [...SLACK_USER_SCOPES] },
  },
};

/** The create-from-manifest URL: drops the user straight into app creation
 * with everything prefilled. They review and click Create. */
export function buildCreateFromManifestUrl(manifest: SlackManifest = FOUNDERS_OS_SLACK_MANIFEST): string {
  const json = JSON.stringify(manifest);
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(json)}`;
}
