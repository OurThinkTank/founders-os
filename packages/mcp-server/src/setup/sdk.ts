// ============================================================
// Founders OS — Agent SDK + API-key preflight (S6.1)
// ============================================================
// Full-run auto-dispatch (`run --execute`) uses the Claude Agent SDK. It
// ships as a normal DEPENDENCY of @ourthinktank/founders-os, so any install
// route that runs the tick (global, local checkout, or the default
// `npx -p @ourthinktank/founders-os@latest` form) pulls it in as a resolvable
// sibling; there is no separate SDK install step to get wrong.
//
// So the only thing `--execute` can be missing is a model API key. This
// preflight (used by `init --execute` and the `autosend --on` follow-through)
// reports that, and keeps a defensive SDK-resolves check so a broken/partial
// install is surfaced rather than failing silently at 3am. `doctor` reports
// the same live state.
// ============================================================

import { createRequire } from "node:module";

export const AGENT_SDK_PKG = "@anthropic-ai/claude-agent-sdk";

export interface SdkCheck {
  sdkInstalled: boolean; // the Agent SDK dependency resolves from here
  apiKey: boolean; // the provider's API key is set
  provider: string; // FOUNDERSOS_AGENT_PROVIDER (default "anthropic")
  apiKeyVar: string; // which env var was checked
  ready: boolean; // both present => the full-run runner can start
  detail: string; // plain-language summary of what's missing
}

/** Which env var holds the key for the configured provider. Anthropic is the
 * default Agent SDK runner; OpenAI (the in-process fallback) reuses
 * OPENAI_API_KEY. */
export function apiKeyVarFor(provider: string): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

/** Is the Agent SDK importable from here? Resolve (not import) so the check is
 * side-effect-free and fast. With the SDK shipped as a dependency this is true
 * for any healthy install; a false is a broken/partial install signal. */
export function isAgentSdkInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve(AGENT_SDK_PKG);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort readiness check for the full-run path. Never throws. */
export function checkAgentSdk(env: NodeJS.ProcessEnv = process.env): SdkCheck {
  const provider = env.FOUNDERSOS_AGENT_PROVIDER ?? "anthropic";
  const apiKeyVar = apiKeyVarFor(provider);
  const sdkInstalled = isAgentSdkInstalled();
  const apiKey = Boolean(env[apiKeyVar]);
  const ready = sdkInstalled && apiKey;
  const detail = ready
    ? "Agent SDK present and API key set"
    : [!sdkInstalled ? `${AGENT_SDK_PKG} did not resolve (incomplete install)` : null, !apiKey ? `${apiKeyVar} not set` : null].filter(Boolean).join("; ");
  return { sdkInstalled, apiKey, provider, apiKeyVar, ready, detail };
}

/** Readiness gate for the full-run path, shared by `init --execute` and the
 * `autosend --on` follow-through. Reports what's pending (a missing API key, or
 * (defensively) an Agent SDK that didn't resolve, without ever prompting for
 * the secret or offering a fragile install. Non-fatal: the caller still wires
 * the schedule, and `doctor` reports whatever remains. Returns the check. */
export function preflightExecute(log: (s: string) => void): SdkCheck {
  const check = checkAgentSdk();

  if (!check.sdkInstalled) {
    log(`The Agent SDK (${AGENT_SDK_PKG}) ships with Founders OS but didn't resolve here; the install looks incomplete. Reinstall @ourthinktank/founders-os (e.g. npm i -g @ourthinktank/founders-os) and retry.`);
  }
  if (!check.apiKey) {
    log(`No ${check.apiKeyVar} found. Add it to your environment (or the tick env file) so the runner can call the model.`);
  }

  return check;
}
