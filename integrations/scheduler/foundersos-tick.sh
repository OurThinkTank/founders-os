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
#                         ~/.config/foundersos-tick.env)
#   FOUNDERSOS_TICK_BIN   the CLI binary (default: founders-os-tick on PATH)
#   FOUNDERSOS_TICK_LOG   log file (default ~/.local/state/foundersos-tick.log)
# ============================================================

set -uo pipefail

ENV_FILE="${FOUNDERSOS_TICK_ENV:-$HOME/.config/foundersos-tick.env}"
TICK_BIN="${FOUNDERSOS_TICK_BIN:-founders-os-tick}"
LOG_FILE="${FOUNDERSOS_TICK_LOG:-$HOME/.local/state/foundersos-tick.log}"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

# Load creds from the env file if present (scheduled jobs get a minimal
# environment and do NOT inherit your shell profile).
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2; }

log "[tick-wrapper] start"

# 1. Detect — fill the inbox.
"$TICK_BIN" detect --json | tee -a "$LOG_FILE"
rc_detect=${PIPESTATUS[0]}

# 2. Drain — stage whatever is pending. Runs even if detect failed, since the
#    runner stages any inbox items that are already waiting.
"$TICK_BIN" run --hold-only --json | tee -a "$LOG_FILE"
rc_run=${PIPESTATUS[0]}

log "[tick-wrapper] done (detect=$rc_detect run=$rc_run)"

# Exit non-zero if either step failed so the scheduler can alert.
[ "$rc_detect" -eq 0 ] && [ "$rc_run" -eq 0 ]
