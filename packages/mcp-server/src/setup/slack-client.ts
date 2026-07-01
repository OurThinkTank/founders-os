// ============================================================
// Founders OS — minimal Slack Web API client (for the connect wizard only)
// ============================================================
// The wizard needs three calls to validate a pasted token, list the user's
// channels, and (optionally) post a test message: auth.test, users.conversations,
// chat.postMessage. This is deliberately tiny and dependency-free (form-encoded
// POST + Bearer). The unattended RUNNER does not use this — it talks to the
// Slack MCP server (mcp.slack.com); this client is just onboarding validation.
//
// fetch is injected (FetchLike) so the client is unit-tested with a mock and
// never needs the network in CI.
// ============================================================

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export function defaultFetch(): FetchLike {
  const g = globalThis as unknown as { fetch?: FetchLike };
  if (!g.fetch) throw new Error("global fetch is unavailable (Node 18+ required)");
  return g.fetch;
}

export interface AuthTestResult {
  ok: boolean;
  error?: string;
  user?: string; // display name
  team?: string; // workspace name
  user_id?: string;
  team_id?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
}

const API = "https://slack.com/api/";

export class SlackClient {
  constructor(private token: string, private fetchFn: FetchLike = defaultFetch()) {}

  private async call(method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const body = new URLSearchParams(params).toString();
    const res = await this.fetchFn(API + method, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body,
    });
    const data = (await res.json()) as Record<string, unknown>;
    return data;
  }

  /** Confirm the token is live and read back the identity. */
  async authTest(): Promise<AuthTestResult> {
    const d = await this.call("auth.test");
    return {
      ok: Boolean(d.ok),
      error: d.error as string | undefined,
      user: d.user as string | undefined,
      team: d.team as string | undefined,
      user_id: d.user_id as string | undefined,
      team_id: d.team_id as string | undefined,
    };
  }

  /** Channels the user is a member of (public + private), for the picker. */
  async listMemberChannels(): Promise<{ ok: boolean; error?: string; channels: SlackChannel[] }> {
    const d = await this.call("users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "200",
    });
    const raw = Array.isArray(d.channels) ? (d.channels as Record<string, unknown>[]) : [];
    return {
      ok: Boolean(d.ok),
      error: d.error as string | undefined,
      channels: raw.map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) })),
    };
  }

  /** Post a single message (the optional connectivity test send). */
  async postMessage(channelId: string, text: string): Promise<{ ok: boolean; error?: string; ts?: string }> {
    const d = await this.call("chat.postMessage", { channel: channelId, text });
    return { ok: Boolean(d.ok), error: d.error as string | undefined, ts: d.ts as string | undefined };
  }
}
