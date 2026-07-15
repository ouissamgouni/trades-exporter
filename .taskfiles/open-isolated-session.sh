#!/usr/bin/env bash
# Open an isolated Chrome session pointing at URL.
#
# Uses a stable per-label profile dir under /tmp/chrome-profiles so repeated
# invocations with the same label focus the existing session instead of
# spawning duplicate windows.

set -euo pipefail

URL="${1:-}"
LABEL="${2:-session}"

if [ -z "$URL" ]; then
  echo "Usage: open-isolated-session.sh <url> [label]"
  exit 1
fi

CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME_BIN" ]; then
  echo "ERROR: Chrome binary not found at: $CHROME_BIN"
  echo "Install Google Chrome or adjust CHROME_BIN in $0"
  exit 1
fi

PROFILE_ROOT="/tmp/chrome-profiles"
PROFILE_DIR="${PROFILE_ROOT}/${LABEL}"
mkdir -p "$PROFILE_DIR"

if pgrep -f "user-data-dir=${PROFILE_DIR}([^/]|$)" >/dev/null 2>&1; then
  echo "Isolated session already open: $LABEL ($PROFILE_DIR)"
  exit 0
fi

echo "Opening isolated Chrome session: $URL"
echo "Label: $LABEL"
echo "Profile dir: $PROFILE_DIR"

"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "$URL" >/dev/null 2>&1 &
disown
