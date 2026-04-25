#!/usr/bin/env bash
# scripts/run-unit-tests.sh — run all unit tests serially.
#
# `node --test` on a directory spawns subprocesses without inheriting
# --experimental-strip-types, so we iterate explicitly. Aggregate exit
# code = sum of failures; non-zero = at least one suite failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

FAIL=0
for f in test/unit/*.test.ts; do
  echo "=== $f ==="
  if ! node --experimental-strip-types --test "$f"; then
    FAIL=$((FAIL + 1))
  fi
  echo
done

if [ "$FAIL" -gt 0 ]; then
  echo "❌ $FAIL test file(s) failed"
  exit 1
else
  echo "✓ all unit-test files passed"
fi
