import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "./utils/env.js";

let client: SupabaseClient | null = null;

/** The message a caller sees when credentials were never provided. */
export const MISSING_CREDENTIALS_MESSAGE =
  "Founders OS is not configured yet.\n" +
  "Set SUPABASE_URL and SUPABASE_SECRET_KEY in your MCP server config.\n\n" +
  "Generate both at https://foundersmcp.com/setup\n\n" +
  "Example (Claude Desktop):\n" +
  '  "env": {\n' +
  '    "SUPABASE_URL": "https://your-project.supabase.co",\n' +
  '    "SUPABASE_SECRET_KEY": "sb_secret_..."\n' +
  "  }";

/** True when both Supabase credentials are present and non-blank. */
export function hasCredentials(): boolean {
  return Boolean(readEnv("SUPABASE_URL") && readEnv("SUPABASE_SECRET_KEY"));
}

/**
 * A stand-in client used when credentials are absent.
 *
 * Why this exists instead of throwing from createServiceClient:
 *
 * The stdio server builds its ToolContext at module load. Throwing there kills
 * the process before the MCP handshake, and a stdio server that dies during
 * startup surfaces to the user as nothing more than "server failed to start" -
 * the one place they cannot read the reason. It also means any tool that
 * enumerates capabilities sees a dead process and zero tools, which is how a
 * registry scan of the packaged bundle ends up reporting no capabilities at all
 * for a server that has over a hundred.
 *
 * So an unconfigured server now boots, registers every tool, and answers
 * tools/list normally. The failure moves to the point of use, where
 * registerToolMap's error path turns it into a readable message with a link,
 * exactly as it does for a database whose schema was never installed.
 *
 * Every property access returns a thrower, so any call shape a caller tries
 * (`db.from(...).select()`, `db.rpc(...)`, `db.auth...`) fails with the same
 * actionable message rather than a TypeError about undefined.
 */
function unconfiguredClient(): SupabaseClient {
  const fail = (): never => {
    throw new Error(MISSING_CREDENTIALS_MESSAGE);
  };
  const handler: ProxyHandler<object> = {
    get: (_target, prop) => {
      // Let runtime type checks and promise unwrapping probe the object
      // without detonating: an accidental `await db` should not be reported
      // to the user as a configuration error.
      if (prop === "then" || prop === Symbol.toStringTag) return undefined;
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => "[Founders OS: unconfigured Supabase client]";
      }
      return fail;
    },
    apply: fail,
  };
  return new Proxy({}, handler) as unknown as SupabaseClient;
}

/**
 * Returns a Supabase service-role client (bypasses RLS).
 * Reads SUPABASE_URL and SUPABASE_SECRET_KEY from environment variables.
 * The client is cached as a singleton for the lifetime of the process.
 *
 * Never throws. When credentials are missing it returns a client that throws
 * MISSING_CREDENTIALS_MESSAGE on first use; see unconfiguredClient above for
 * why the failure is deferred rather than raised here.
 *
 * Read via readEnv so a blank value counts as absent: MCPB install dialogs
 * substitute "" for a field the user left empty.
 */
export function createServiceClient(): SupabaseClient {
  if (client) return client;

  const url = readEnv("SUPABASE_URL");
  const key = readEnv("SUPABASE_SECRET_KEY");

  if (!url || !key) {
    // Deliberately NOT cached: the process may be re-checked after the user
    // fixes their config, and caching a dud would outlive the mistake.
    return unconfiguredClient();
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return client;
}
