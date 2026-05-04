#!/usr/bin/env bash
# Recce Weekly Audit Suite — full crawl with deep checks.
# Runs off-peak (e.g. 03:00 UTC Sundays). Aborts cleanly on origin outage.
set -euo pipefail

cd /home/gordon/work/recce || exit 1

if [[ -z "${BASE_URL:-}" ]]; then
  echo "BASE_URL required (e.g. BASE_URL=https://valors.io)" >&2
  exit 1
fi
if [[ -z "${RECCE_AUDIT_DISCORD_WEBHOOK:-}" ]]; then
  echo "RECCE_AUDIT_DISCORD_WEBHOOK required (audit-mode webhook)" >&2
  exit 1
fi

export BASE_URL
# The reporter reads RECCE_DISCORD_WEBHOOK; map the audit webhook into it.
export RECCE_DISCORD_WEBHOOK="$RECCE_AUDIT_DISCORD_WEBHOOK"
export RECCE_MODE=audit
export MAX_PAGES="${MAX_PAGES:-2000}"

# PID lock — prevents concurrent audit runs colliding.
PID_FILE="/tmp/recce-audit.pid"
if [[ -f "$PID_FILE" ]]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || echo '')"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "recce-audit: already running (PID $OLD_PID) — exiting" >&2
    exit 1
  else
    echo "recce-audit: stale PID file (PID=$OLD_PID not alive), overwriting" >&2
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

# Pre-flight origin health check — abort cleanly on origin outage so a
# transient upstream blip does not page on-call.
echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Pre-flight origin health: GET ${BASE_URL}/"
# curl -w '%{http_code}' already writes "000" to stdout on connect/DNS failure,
# so we do NOT append a fallback "000" in the || branch (that would concatenate
# to "000000" and break the regex). `|| true` so set -e does not abort.
# `-L` follows redirects so a 301/302 from "${BASE_URL}/" to a canonical
# host (e.g. www. prefix, https upgrade, locale split) does not abort the
# audit — STATUS captures the final status code after the redirect chain.
STATUS="$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/" 2>/dev/null || true)"
STATUS="${STATUS:-000}"
if [[ ! "$STATUS" =~ ^2[0-9][0-9]$ ]]; then
  MSG="recce audit aborted — origin unreachable: $BASE_URL returned $STATUS"
  echo "$MSG" >&2
  if command -v wilco-notify >/dev/null 2>&1; then
    # `--` terminates option parsing so a future $MSG containing a leading
    # `-` cannot be misread as a flag. Aligns with safeWilcoNotify on the JS
    # side (which passes argv directly so no shell parse happens at all).
    wilco-notify --level warning -- "$MSG" || true
  fi
  # Exit 0 — a transient origin outage is not a Recce failure.
  exit 0
fi
echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Origin OK (HTTP $STATUS) — starting audit (MAX_PAGES=$MAX_PAGES)"

EXIT_CODE=0
npx playwright test 2>&1 | tee /tmp/recce-audit-last-run.log || EXIT_CODE=$?

if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce audit FAILED (exit code: $EXIT_CODE)"
else
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce audit complete — all passed"
fi

exit "$EXIT_CODE"
