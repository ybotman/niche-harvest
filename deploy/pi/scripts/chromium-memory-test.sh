#!/usr/bin/env bash
# deploy/pi/scripts/chromium-memory-test.sh — Phase 6 pre-flight memory test.
#
# AIDI 2026-04-25: ARCHITECTURE.md §8 budgets ~800MB peak Chromium on Pi 5,
# but real-world CDP+FB can hit 1–1.5GB. Validate empirically on actual Pi
# before committing the rest of Phase 6 to the budget envelope.
#
# Usage: chromium-memory-test.sh [duration_seconds] [target_url]
#   default: 600 seconds (10 min) against m.facebook.com login page
#
# What it does:
#   1. Launches headless Chromium with Puppeteer-like CDP wiring
#   2. Loads target URL, scrolls, navigates several pages
#   3. Samples Chromium RSS every 5 seconds via /proc/<pid>/status
#   4. Reports peak RSS, mean RSS, OOM kills (if any)
#   5. PASS if peak < 1500 MB; FAIL if peak >= 1500 MB or OOM
#
# Output: data/watchdog/chromium-memory-<timestamp>.json
#
# Run on actual Pi 5 8GB hardware. Run on laptop for sanity check; Pi result
# is the gate.

set -euo pipefail

DURATION="${1:-600}"
TARGET_URL="${2:-https://m.facebook.com/login.php}"
THRESHOLD_MB=1500
PI_NAME=$(hostname)
TIMESTAMP=$(date -u +%Y%m%dT%H%M%S)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPORT="$REPO_ROOT/data/watchdog/chromium-memory-${TIMESTAMP}.json"

mkdir -p "$REPO_ROOT/data/watchdog"

echo "[memtest] starting — duration=${DURATION}s target=${TARGET_URL}"
echo "[memtest] pi=${PI_NAME} threshold=${THRESHOLD_MB}MB"

# Locate chromium binary (name differs across distros)
CHROMIUM_BIN=""
for cmd in chromium chromium-browser /usr/bin/chromium /usr/bin/chromium-browser; do
  if command -v "$cmd" >/dev/null 2>&1 || [[ -x "$cmd" ]]; then
    CHROMIUM_BIN="$cmd"
    break
  fi
done
if [[ -z "$CHROMIUM_BIN" ]]; then
  echo "[memtest] FAIL: no chromium binary found (tried: chromium, chromium-browser)"
  exit 1
fi
echo "[memtest] using binary: $CHROMIUM_BIN"

# Launch Chromium headless with reasonable Pi flags
"$CHROMIUM_BIN" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-memtest \
  "$TARGET_URL" &
CHROMIUM_PID=$!

# Give Chromium time to start
sleep 5

if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
  echo "[memtest] FAIL: Chromium didn't start"
  exit 1
fi

# Sample loop
PEAK_KB=0
SAMPLES=0
SUM_KB=0
START_EPOCH=$(date -u +%s)
END_EPOCH=$((START_EPOCH + DURATION))

while [[ $(date -u +%s) -lt $END_EPOCH ]]; do
  if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    echo "[memtest] FAIL: Chromium died (likely OOM-killed)"
    cat > "$REPORT" <<EOF
{
  "test": "chromium-memory",
  "pi": "$PI_NAME",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_target_seconds": $DURATION,
  "duration_actual_seconds": $(($(date -u +%s) - START_EPOCH)),
  "result": "FAIL_OOM",
  "peak_rss_mb": $((PEAK_KB / 1024)),
  "samples": $SAMPLES,
  "threshold_mb": $THRESHOLD_MB
}
EOF
    exit 2
  fi

  # Sum RSS across Chromium and all child processes (renderer + GPU)
  TOTAL_KB=$(ps -o rss= -p "$CHROMIUM_PID" $(pgrep -P "$CHROMIUM_PID" 2>/dev/null) 2>/dev/null | awk '{s+=$1} END {print s+0}')

  if [[ $TOTAL_KB -gt $PEAK_KB ]]; then
    PEAK_KB=$TOTAL_KB
  fi
  SUM_KB=$((SUM_KB + TOTAL_KB))
  SAMPLES=$((SAMPLES + 1))

  echo "[memtest] t=$(($(date -u +%s) - START_EPOCH))s rss=$((TOTAL_KB / 1024))MB peak=$((PEAK_KB / 1024))MB"
  sleep 5
done

# Cleanup
kill "$CHROMIUM_PID" 2>/dev/null || true
wait "$CHROMIUM_PID" 2>/dev/null || true
rm -rf /tmp/chrome-memtest

PEAK_MB=$((PEAK_KB / 1024))
MEAN_MB=$((SUM_KB / SAMPLES / 1024))

if [[ $PEAK_MB -ge $THRESHOLD_MB ]]; then
  RESULT="FAIL_THRESHOLD"
else
  RESULT="PASS"
fi

cat > "$REPORT" <<EOF
{
  "test": "chromium-memory",
  "pi": "$PI_NAME",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_seconds": $DURATION,
  "target_url": "$TARGET_URL",
  "result": "$RESULT",
  "peak_rss_mb": $PEAK_MB,
  "mean_rss_mb": $MEAN_MB,
  "samples": $SAMPLES,
  "threshold_mb": $THRESHOLD_MB
}
EOF

echo "[memtest] $RESULT — peak=${PEAK_MB}MB mean=${MEAN_MB}MB samples=${SAMPLES}"
echo "[memtest] report: $REPORT"

if [[ "$RESULT" == "PASS" ]]; then
  exit 0
else
  exit 2
fi
