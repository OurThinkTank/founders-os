// ============================================================
// Founders OS — tick-bin resolution + preflight
// ============================================================
// The scheduled wrapper invokes the tick CLI by FOUNDERSOS_TICK_BIN. The
// happy path is the published npx form; but a dev checkout, a global install,
// or an nvm PATH all change how (or whether) the command resolves. Rather
// than hope, `init` PRE-FLIGHTS the chosen bin here, and self-heals to the
// current local invocation when the published command isn't reachable.
// ============================================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// The same locations the wrapper prepends, so a preflight mirrors what the
// scheduler will see (its PATH is minimal and won't include these otherwise).
const PATH_PREPEND = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME ?? ""}/.local/bin`, `${process.env.HOME ?? ""}/.npm-global/bin`];

export interface BinCheck {
  ok: boolean;
  version?: string;
  detail: string;
}

/** Quote an argv token for a shell command line if it needs it. */
export function quoteArg(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/** True if a script path lives inside an npx cache (ephemeral — not a stable
 * thing to point a scheduler at). */
export function isNpxCachePath(p: string): boolean {
  return /[\\/]_npx[\\/]/.test(p);
}

/** The current process's own invocation as a durable command, or null when it
 * isn't durable (npx cache) or the script is gone. Used as the dev/global
 * fallback when the published command doesn't resolve. */
export function localSelfInvocation(argv1: string | undefined = process.argv[1], execPath: string = process.execPath): string | null {
  if (!argv1 || isNpxCachePath(argv1) || !existsSync(argv1)) return null;
  return `${quoteArg(execPath)} ${quoteArg(argv1)}`;
}

/** Run `<tickBin> --version` the way the scheduler would, and report whether
 * it resolves. Best-effort and bounded: a timeout (npx may fetch) is reported
 * as "unverified", not a hard failure. */
export function checkTickBinResolves(tickBin: string, timeoutMs = 20000): BinCheck {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env, PATH: [...PATH_PREPEND, process.env.PATH ?? ""].join(sep) };
  const r = spawnSync(`${tickBin} --version`, { shell: true, encoding: "utf-8", timeout: timeoutMs, env });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return { ok: false, detail: "timed out (slow network fetching the package?) — it may still work" };
    return { ok: false, detail: r.error.message };
  }
  if (r.status === 0) {
    const version = (r.stdout || "").trim().split("\n").filter(Boolean).pop();
    return { ok: true, version, detail: version ? `resolved (${version})` : "resolved" };
  }
  const detail = (r.stderr || "").trim().split("\n").filter(Boolean).pop() || `exit ${r.status}`;
  return { ok: false, detail };
}
