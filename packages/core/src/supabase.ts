import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Returns a Supabase service-role client (bypasses RLS).
 * Reads SUPABASE_URL and SUPABASE_SECRET_KEY from environment variables.
 * The client is cached as a singleton for the lifetime of the process.
 */
export function createServiceClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing required environment variables.\n" +
        "Set SUPABASE_URL and SUPABASE_SECRET_KEY in your MCP server config.\n\n" +
        "Example (Claude Desktop):\n" +
        '  "env": {\n' +
        '    "SUPABASE_URL": "https://your-project.supabase.co",\n' +
        '    "SUPABASE_SECRET_KEY": "sb_secret_..."\n' +
        "  }"
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return client;
}
