#!/bin/bash
# Build "Site Admin.app" — a double-clickable launcher for the admin console.
#
# The app starts admin.js in the background (unless something already listens
# on port 3001), opens http://localhost:3001 in your normal browser, and stops
# the server again when you quit it from the Dock (Cmd+Q).  Clicking the Dock
# icon reopens the page.  Server output goes to ~/Library/Logs/site-admin.log.
# The repo path and node path are baked in, so rebuild if either moves.
#
#   ./build-admin-app.sh              # build build/Site Admin.app
#   ./build-admin-app.sh --install    # …and copy it to /Applications
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Site Admin"

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
    echo "error: 'node' not found on PATH — install Node.js first." >&2
    exit 1
fi

# Escape a value as an AppleScript string literal.
as_str() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '"%s"' "$s"; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cat > "$TMP_DIR/main.applescript" <<EOF
global serverPID

on run
	set serverPID to ""
	set repoDir to $(as_str "$REPO_DIR")
	set nodePath to $(as_str "$NODE_PATH")
	set logFile to (POSIX path of (path to home folder)) & "Library/Logs/site-admin.log"

	set alreadyRunning to true
	try
		do shell script "lsof -ti tcp:3001 -sTCP:LISTEN"
	on error
		set alreadyRunning to false
	end try

	if not alreadyRunning then
		-- Output must be redirected or do shell script waits forever.
		set serverPID to do shell script "cd " & quoted form of repoDir & " && PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin nohup " & quoted form of nodePath & " admin.js >> " & quoted form of logFile & " 2>&1 & echo \$!"
	end if

	repeat 20 times
		try
			do shell script "curl -s -o /dev/null --max-time 1 http://localhost:3001"
			do shell script "open http://localhost:3001"
			return
		end try
		delay 0.5
	end repeat

	display dialog "The site admin didn't start." & return & return & "See ~/Library/Logs/site-admin.log for details." buttons {"OK"} default button 1 with icon stop
	quit
end run

on reopen
	do shell script "open http://localhost:3001"
end reopen

on quit
	try
		if serverPID is not "" then do shell script "kill " & serverPID
	end try
	continue quit
end quit
EOF

APP="$TMP_DIR/$APP_NAME.app"
osacompile -s -o "$APP" "$TMP_DIR/main.applescript"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.adamlilienfeldt.site-admin" "$APP/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.adamlilienfeldt.site-admin" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" 2>/dev/null || true   # Info.plist edit invalidates the signature

if [ "$1" = "--install" ]; then
    if pgrep -f "/$APP_NAME.app/Contents/MacOS/" >/dev/null; then
        echo "error: $APP_NAME is running — quit it (Cmd+Q) and run this again." >&2
        exit 1
    fi
    rm -rf "/Applications/$APP_NAME.app"
    ditto "$APP" "/Applications/$APP_NAME.app"
    echo "Installed /Applications/$APP_NAME.app"
else
    mkdir -p "$REPO_DIR/build"
    rm -rf "$REPO_DIR/build/$APP_NAME.app"
    ditto "$APP" "$REPO_DIR/build/$APP_NAME.app"
    echo "Built $REPO_DIR/build/$APP_NAME.app"
    if ! git -C "$REPO_DIR" check-ignore -q build/ 2>/dev/null; then
        echo "note: build/ is not in .gitignore — add it so the app isn't committed."
    fi
fi
