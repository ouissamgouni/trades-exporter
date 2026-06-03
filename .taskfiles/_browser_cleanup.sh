#!/usr/bin/env bash
# Close Chrome processes whose --user-data-dir lives under
# /tmp/chrome-profiles/<prefix>* and remove those profile dirs.

set -euo pipefail

PREFIX="${1:-}"
if [ -z "$PREFIX" ]; then
  echo "Usage: _browser_cleanup.sh <prefix>"
  exit 1
fi

ROOT="/tmp/chrome-profiles"
if [ ! -d "$ROOT" ]; then
  exit 0
fi

MATCHES=$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name "${PREFIX}*" 2>/dev/null || true)
if [ -z "$MATCHES" ]; then
  exit 0
fi

echo "Closing Chrome sessions: ${PREFIX}*"
for dir in $MATCHES; do
  pkill -f "user-data-dir=${dir}([^/]|$)" 2>/dev/null || true
done

sleep 1

for dir in $MATCHES; do
  rm -rf "$dir" 2>/dev/null || true
  echo "removed $dir"
done
