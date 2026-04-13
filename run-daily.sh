#!/usr/bin/env bash
# Recce Daily E2E Suite — runs at 08:30 UTC via cron
set -uo pipefail

cd /home/gordon/work/recce || exit 1

export BASE_URL="${BASE_URL:-https://valors.io}"
export RECCE_DISCORD_WEBHOOK="${RECCE_DISCORD_WEBHOOK:-https://discord.com/api/webhooks/1430931672500535406/f2bEMG3ITW96vHNnB3tUPB5TNUHFWbRla2BT3epM5L51qNjfwfMDUHXWOnYXxKPsydhu}"
NODE_VERSION=$(ls /home/gordon/.nvm/versions/node/ 2>/dev/null | tail -1)
export PATH="/home/gordon/.nvm/versions/node/${NODE_VERSION}/bin:$PATH"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Starting Recce E2E suite"

EXIT_CODE=0
npx playwright test 2>&1 | tee /tmp/recce-last-run.log || EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce E2E suite FAILED (exit code: $EXIT_CODE)"
else
  echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] Recce E2E suite complete — all passed"
fi

exit $EXIT_CODE
