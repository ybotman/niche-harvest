#!/usr/bin/env bash
# run.sh — niche-harvest entrypoint.
#
# Usage:
#   ./run.sh --niche=<key> snapshot [--dry-run] [--source=<name>]
#
# Wraps the appropriate CLI module under core/cli/. Phase 1 supports only
# the `snapshot` command (iCal-only, no geocode, no Mongo). Future commands
# (enrich, geocode, load, scheduler) land here as new branches.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Parse positional command ───
COMMAND=""
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    snapshot|enrich|geocode|load|scheduler)
      if [[ -z "$COMMAND" ]]; then
        COMMAND="$arg"
      else
        PASSTHROUGH+=("$arg")
      fi
      ;;
    *)
      PASSTHROUGH+=("$arg")
      ;;
  esac
done

if [[ -z "$COMMAND" ]]; then
  cat >&2 <<EOF
run.sh: missing command

Usage: ./run.sh --niche=<key> <command> [flags]

Commands:
  snapshot   Fetch all in-scope sources, dedup-insert into SQLite,
             emit JSON snapshot to data/<niche>/snapshots/<YYYY-MM-DD>.json

Phase 1 supports only: snapshot
EOF
  exit 2
fi

# ─── Dispatch ───
case "$COMMAND" in
  snapshot)
    exec node --experimental-strip-types core/cli/snapshot.ts "${PASSTHROUGH[@]}"
    ;;
  enrich)
    exec node --experimental-strip-types core/cli/enrich.ts "${PASSTHROUGH[@]}"
    ;;
  load)
    exec node --experimental-strip-types core/cli/load.ts "${PASSTHROUGH[@]}"
    ;;
  geocode|scheduler)
    echo "run.sh: command '$COMMAND' not yet implemented (Phase 1+2 ships snapshot + enrich + load)" >&2
    exit 3
    ;;
  *)
    echo "run.sh: unknown command '$COMMAND'" >&2
    exit 2
    ;;
esac
