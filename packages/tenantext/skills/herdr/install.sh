#!/usr/bin/env bash
# Install the herdr skill at user level for Pi or Claude Code without the plugin.
# Claude Code plugin users do not need this installer.
# Usage: skills/herdr/install.sh
# It is safe to run again. It replaces the installed copy.
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
dest="${HERDR_SKILL_HOME:-$HOME/.agents/skills/herdr}"

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
chmod +x "$dest"/scripts/*.py "$dest"/scripts/*.sh "$dest/install.sh"
echo "skill:   $dest"

link() { # <skills directory of a harness>
  mkdir -p "$1"
  if [ -L "$1/herdr" ] || [ ! -e "$1/herdr" ]; then
    ln -sfn "$dest" "$1/herdr"
    echo "link:    $1/herdr"
  else
    echo "skipped: $1/herdr exists and is not a link" >&2
  fi
}

if [ -d "$HOME/.claude" ]; then
  link "$HOME/.claude/skills"
  mkdir -p "$HOME/.claude/commands"
  cp "$dest/commands/spawn_agent.md" "$HOME/.claude/commands/spawn_agent.md"
  echo "command: $HOME/.claude/commands/spawn_agent.md"
fi
if [ -d "$HOME/.pi/agent" ]; then
  # Pi can find the skill in more than one place. The user directory has priority,
  # so this link decides which copy Pi loads.
  link "$HOME/.pi/agent/skills"
  mkdir -p "$HOME/.pi/agent/prompts"
  cp "$dest/commands/spawn_agent.md" "$HOME/.pi/agent/prompts/spawn_agent.md"
  echo "command: $HOME/.pi/agent/prompts/spawn_agent.md"
fi
echo "Start a new session, or run /reload in pi, to load the skill."
