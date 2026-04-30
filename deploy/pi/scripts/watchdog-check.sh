#!/usr/bin/env bash
# deploy/pi/scripts/watchdog-check.sh — checks scheduler heartbeat freshness.
#
# Usage: watchdog-check.sh <niche> <max_age_seconds>
#   <niche>           niche key (e.g., 'tango')
#   <max_age_seconds> heartbeat older than this triggers restart (default 7200 = 2h)
#
# Behavior:
#   - Reads data/<niche>/scheduler.heartbeat (JSON)
#   - If file missing or older than max_age, restart niche-harvest.service
#   - Logs to journald via systemd

set -euo pipefail

NICHE="${1:-tango}"
MAX_AGE="${2:-7200}"
HEARTBEAT="data/${NICHE}/scheduler.heartbeat"

if [[ ! -f "$HEARTBEAT" ]]; then
  echo "watchdog: heartbeat file missing: $HEARTBEAT" >&2
  echo "watchdog: not restarting (scheduler may be initializing)"
  exit 0
fi

# Heartbeat timestamp from JSON; epoch seconds
HEARTBEAT_TS=$(python3 -c "
import json, datetime, sys
with open('$HEARTBEAT') as f:
    h = json.load(f)
ts = datetime.datetime.fromisoformat(h['timestamp'].rstrip('Z'))
print(int(ts.replace(tzinfo=datetime.timezone.utc).timestamp()))
" 2>/dev/null || echo "0")

if [[ "$HEARTBEAT_TS" == "0" ]]; then
  echo "watchdog: heartbeat unparseable; not restarting" >&2
  exit 0
fi

NOW=$(date -u +%s)
AGE=$((NOW - HEARTBEAT_TS))

if [[ $AGE -gt $MAX_AGE ]]; then
  echo "watchdog: heartbeat stale (${AGE}s > ${MAX_AGE}s) — restarting niche-harvest.service" >&2
  systemctl restart niche-harvest.service
  exit 1
fi

echo "watchdog: heartbeat fresh (${AGE}s old)"
exit 0
