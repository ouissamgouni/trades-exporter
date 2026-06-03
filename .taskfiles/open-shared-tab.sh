#!/usr/bin/env bash
# Open a URL in the default Chrome profile. If a matching tab exists, focus and
# reload it; otherwise open a new Chrome window.

set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: open-shared-tab.sh <url>"
  exit 1
fi

osascript -e "
set targetURL to \"$URL\"

if application \"Google Chrome\" is running then
  tell application \"Google Chrome\"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        set tabURL to URL of t
        if tabURL is targetURL or tabURL starts with (targetURL & \"/\") or tabURL starts with (targetURL & \"?\") or tabURL starts with (targetURL & \"#\") then
          set found to true
          set active tab index of w to tabIndex
          set index of w to 1
          reload t
          activate
          return
        end if
      end repeat
    end repeat
    if not found then
      make new window
      set URL of active tab of front window to targetURL
      activate
    end if
  end tell
else
  do shell script \"open -na 'Google Chrome' --args --new-window \" & quoted form of targetURL
end if
" 2>/dev/null
