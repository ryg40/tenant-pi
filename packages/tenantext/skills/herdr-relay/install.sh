#!/usr/bin/env bash
# Install the herdr-relay skill at user level for Claude Code and pi.
# Usage: skills/herdr-relay/install.sh
# It is safe to run again. It needs the herdr skill. The installed path becomes a link to this folder,
# so a pull of the kit updates the skill at once. A real directory at that path moves to a backup name beside it.
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
dest="${HERDR_RELAY_SKILL_HOME:-$HOME/.agents/skills/herdr-relay}"

mkdir -p "$(dirname "$dest")"
if [ ! -L "$dest" ] && [ "$(cd "$dest" 2>/dev/null && pwd -P || true)" = "$src" ]; then
  echo "skill:   $dest is this folder"
else
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    stamp="$dest.backup-$(date +%Y%m%d-%H%M%S)"
    backup="$stamp" n=1
    while [ -e "$backup" ] || [ -L "$backup" ]; do backup="$stamp-$n"; n=$((n + 1)); done
    mv "$dest" "$backup"
    echo "backup:  $backup"
  fi
  ln -sfn "$src" "$dest"
  echo "skill:   $dest -> $src"
fi
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
