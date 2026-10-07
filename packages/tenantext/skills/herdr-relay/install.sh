#!/usr/bin/env bash
# Install the herdr-relay skill at user level for Claude Code and pi.
# Usage: skills/herdr-relay/install.sh
# It is safe to run again. It replaces the installed copy. It needs the herdr skill.
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
dest="${HERDR_RELAY_SKILL_HOME:-$HOME/.agents/skills/herdr-relay}"

mkdir -p "$(dirname "$dest")"
if [ -L "$dest" ]; then rm "$dest"; fi
if [ "$src" != "$(cd "$dest" 2>/dev/null && pwd -P || true)" ]; then
  mkdir -p "$dest"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '__pycache__' "$src/" "$dest/"
  else
    rm -rf "${dest:?}"/* && cp -R "$src/." "$dest/"
  fi
fi
chmod +x "$dest"/scripts/*.py "$dest/install.sh"
echo "skill:   $dest"
[ -d "${HERDR_SKILL_HOME:-$HOME/.agents/skills/herdr}" ] || echo "warning: the herdr skill is not installed; relay.py needs it" >&2

link() { # <skills directory of a harness>
  mkdir -p "$1"
  if [ -L "$1/herdr-relay" ] || [ ! -e "$1/herdr-relay" ]; then
    ln -sfn "$dest" "$1/herdr-relay"
    echo "link:    $1/herdr-relay"
  else
    echo "skipped: $1/herdr-relay exists and is not a link" >&2
  fi
}

if [ -d "$HOME/.claude" ]; then link "$HOME/.claude/skills"; fi
if [ -d "$HOME/.pi/agent" ]; then link "$HOME/.pi/agent/skills"; fi
echo "Start a new session, or run /reload in pi, to load the skill."
