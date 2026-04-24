#!/usr/bin/env bash
# Recce Daily E2E Suite — runs at 08:30 UTC via cron.
# Pulse mode: fast chromium-only crawl for daily sanity.
set -euo pipefail

cd /home/gordon/work/recce || exit 1

# Hard-require env vars (no plaintext fallbacks — removed the hardcoded webhook
# previously at line 8 as a security liability).
if [[ -z "${BASE_URL:-}" ]]; then
  echo "BASE_URL required (e.g. BASE_URL=https://valors.io)" >&2
  exit 1
fi
if [[ -z "${RECCE_DISCORD_WEBHOOK:-}" ]]; then
  echo "RECCE_DISCORD_WEBHOOK required" >&2
  exit 1
fi

export BASE_URL
export RECCE_DISCORD_WEBHOOK
export RECCE_MODE="${RECCE_MODE:-pulse}"

# PID lock — prevents two pulse runs colliding on the same findings directory.
PID_FILE="/tmp/recce-pulse.pid"
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || echo '')"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "recce-pulse: already running (PID $OLD_PID) — exiting" >&2
    exit 1
  else
    echo "recce-pulse: stale PID file (PID=$OLD_PID not alive), overwriting" >&2
    rm -f "$PID_FILE"
  fi
fi
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

# Node / PATH setup — pick highest semver (not lexicographic, which picks v9
# before v18). `sort -V` is GNU sort version-sort; available on Ubuntu and
# Debian-based VPS hosts the crawler runs on.
if [[ -d /home/gordon/.nvm/versions/node ]]; then
  # shellcheck disable=SC2012  # ls + sort -V is the portable version-sort path
  NODE_VERSION="$(ls /home/gordon/.nvm/versions/node/ 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$NODE_VERSION" ]]; then
    export PATH="/home/gordon/.nvm/versions/node/${NODE_VERSION}/bin:$PATH"
  fi
fi

echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Starting Recce E2E suite (mode=$RECCE_MODE)"

EXIT_CODE=0
npx playwright test 2>&1 | tee /tmp/recce-last-run.log || EXIT_CODE=$?

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce E2E suite FAILED (exit code: $EXIT_CODE)"
else
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce E2E suite complete — all passed"
fi

exit "$EXIT_CODE"
