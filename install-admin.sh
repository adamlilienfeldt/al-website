#!/bin/bash
# One-time setup of Site Admin on another Mac. Paste into Terminal:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/adamlilienfeldt/al-website/main/install-admin.sh)
#
# It installs what's missing (git, Node, GitHub login), downloads the site to
# ~/Code/DEV/al-website (set AL_WEBSITE_DIR to use another folder), checks
# that publishing to GitHub will work, and puts Site Admin.app in
# /Applications. Safe to run again; it skips what's already done.
set -e

REPO_URL="https://github.com/adamlilienfeldt/al-website.git"
DEST="${AL_WEBSITE_DIR:-$HOME/Code/DEV/al-website}"
step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nerror: %s\n' "$1" >&2; exit 1; }

step "Checking git"
if ! xcode-select -p >/dev/null 2>&1; then
    xcode-select --install || true
    fail "Apple's developer tools are installing (a window opened). When they're done, run this command again."
fi

step "Checking Node.js"
if ! command -v node >/dev/null; then
    command -v brew >/dev/null || fail "Node.js is missing. Install it from https://nodejs.org (LTS), then run this command again."
    brew install node
fi
echo "node $(node --version)"

step "Getting the site into $DEST"
if [ -d "$DEST/.git" ]; then
    git -C "$DEST" pull --ff-only || echo "(couldn't update; using the copy that's there)"
else
    mkdir -p "$(dirname "$DEST")"
    git clone "$REPO_URL" "$DEST"
fi
cd "$DEST"

step "Installing site dependencies"
npm ci

step "Checking you can publish to GitHub"
# Publishing commits as you, so git needs a name and email.
git config user.email >/dev/null || git config user.email "lilienfeldt.adam@gmail.com"
git config user.name >/dev/null || git config user.name "Adam Lilienfeldt"
# Logs in once; the app then pushes with the saved login.
if ! git push --dry-run origin main >/dev/null 2>&1; then
    command -v gh >/dev/null || { command -v brew >/dev/null && brew install gh; } \
        || fail "Install the GitHub CLI (https://cli.github.com), then run this command again."
    gh auth status >/dev/null 2>&1 || gh auth login --hostname github.com --git-protocol https --web
    gh auth setup-git
    git push --dry-run origin main >/dev/null 2>&1 \
        || fail "Still can't push to GitHub. Check you're logged in as adamlilienfeldt (gh auth status)."
fi
echo "publishing works"

step "Installing Site Admin.app"
./build-admin-app.sh --install

printf '\nDone. Open Site Admin from Applications (or Spotlight: "Site Admin").\n'
