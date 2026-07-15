#!/usr/bin/env bash
# Open browser instance(s) at URL.
#
# Usage: open-browsers.sh <url> <mode> <count> <label> [reset]
#   mode    none      no-op (servers-only workflow)
#           shared    focus an existing Chrome tab matching URL, else open one
#           isolated  open <count> Chrome sessions, each with its own profile
#   count   positive integer; only used for isolated mode
#   label   short identifier used in isolated profile paths
#   reset   if "1", wipe matching isolated profile dirs before launching

set -euo pipefail

URL="${1:-}"
MODE="${2:-none}"
COUNT="${3:-1}"
LABEL="${4:-session}"
RESET="${5:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$URL" ]; then
  echo "Usage: open-browsers.sh <url> <mode> <count> <label> [reset]"
  exit 1
fi

case "$MODE" in
  none)
    exit 0
    ;;
  shared)
    "$SCRIPT_DIR/open-shared-tab.sh" "$URL"
    ;;
  isolated)
    if ! echo "$COUNT" | grep -Eq '^[0-9]+$' || [ "$COUNT" -lt 1 ]; then
      echo "ERROR: COUNT must be a positive integer (got '$COUNT')"
      exit 1
    fi
    if [ "$RESET" = "1" ]; then
      "$SCRIPT_DIR/_browser_cleanup.sh" "$LABEL"
    fi
    for index in $(seq 1 "$COUNT"); do
      "$SCRIPT_DIR/open-isolated-session.sh" "$URL" "${LABEL}-${index}"
    done
    ;;
  *)
    echo "ERROR: Unknown BROWSER mode: '$MODE' (expected: none|shared|isolated)"
    exit 1
    ;;
esac
