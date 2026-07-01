#!/usr/bin/env bash
# ============================================================
# Founders OS — tick wrapper (detect + run --hold-only)
# ============================================================
# One scheduled run = the check then the drain:
#   1. founders-os-tick detect          fills the trigger_fires inbox
#   2. founders-os-tick run --hold-only  stages every fire for human review
# They run serially (detect finishes before run starts). Nothing is ever
# performed — staged items wait in the approval queue for a human.
#
# Point your OS scheduler (launchd / systemd / cron) at THIS script instead
# of the bare commands, so one job does both halves. See
# founders-os-docs/guides/tick-cli-usage.md.
#
# Config (all optional, override via env or the env file):
#   FOUNDERSOS_TICK_ENV   path to an env file with SUPABASE_URL /
#                         SUPABASE_SECRET_KEY / FOUNDERS_OS_* (default
#                         ~/.config/founders-os/foundersos-tick.env)
#   FOUNDERSOS_TICK_BIN   how to invoke the tick CLI. Default
#                         "founders-os-tick" assumes a GLOBAL install
#                         (npm i -g @ourthinktank/founders-os). If you run
#                         the package via npx instead, set this to the npx
#                         form (the tick is the package's second bin):
#                           npx -y -p @ourthinktank/founders-os@latest founders-os-tick
#                         or, for local dev:
#                           npx tsx /path/to/packages/mcp-server/src/tick.ts
#                         It may be a multi-word command (paths must not
#                         contain spaces).
#   FOUNDERSOS_TICK_LOG   log file (default ~/.local/state/foundersos-tick.log)
# ============================================================

set -uo pipefail

ENV_FILE="${FOUNDERSOS_TICK_ENV:-$HOME/.config/founders-os/foundersos-tick.env}"
LOG_FILE="${FOUNDERSOS_TICK_LOG:-$HOME/.local/state/foundersos-tick.log}"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# Load creds from the env file if present (scheduled jobs get a minimal
# environment and do NOT inherit your shell profile). This is also where
# FOUNDERSOS_TICK_BIN can be set, so resolve the command AFTER sourcing it.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# Scheduled jobs (launchd/systemd) start with a minimal PATH that usually
# lacks node/npx, so an npx-based command would fail with "command not found".
# Add the common install locations. nvm or other non-standard installs: set
# PATH in the env file, or point FOUNDERSOS_TICK_BIN at an absolute npx path.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# FOUNDERSOS_TICK_BIN may be a multi-word command (a global binary, an npx
# invocation, or a dev `npx tsx ...` command). Split it into argv. Paths
# with spaces are not supported - use a global install or a symlink.
read -r -a TICK_CMD <<< "${FOUNDERSOS_TICK_BIN:-founders-os-tick}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

log "[tick-wrapper] start"

# 1. Detect — fill the inbox.
"${TICK_CMD[@]}" detect --json | tee -a "$LOG_FILE"
rc_detect=${PIPESTATUS[0]}

# 2. Drain — stage whatever is pending. Runs even if detect failed, since the
#    runner stages any inbox items that are already waiting.
"${TICK_CMD[@]}" run --hold-only --json | tee -a "$LOG_FILE"
rc_run=${PIPESTATUS[0]}

log "[tick-wrapper] done (detect=$rc_detect run=$rc_run)"

# Exit non-zero if either step failed so the scheduler can alert.
[ "$rc_detect" -eq 0 ] && [ "$rc_run" -eq 0 ]
