#!/usr/bin/env bash
# Link each skill of the knowledge-skills component at user level for Claude Code and Pi.
# Usage: skills/knowledge-skills/install.sh
# It is safe to run again. It copies nothing: each link points at the shipped directory.
# A target that exists and is not a link is reported and left alone.
# KNOWLEDGE_SKILLS_HOME replaces $HOME; use it for a test.
set -euo pipefail

src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
home="${KNOWLEDGE_SKILLS_HOME:-$HOME}"

link() { # <skills directory of a harness> <skill directory>
  local name
  name=$(basename "$2")
  mkdir -p "$1"
  if [ -L "$1/$name" ] || [ ! -e "$1/$name" ]; then
    ln -sfn "$2" "$1/$name"
    echo "link:    $1/$name"
  else
    echo "skipped: $1/$name exists and is not a link" >&2
  fi
}

found=0
for skill in "$src"/*/; do
  skill=${skill%/}
  [ -f "$skill/SKILL.md" ] || continue
  found=1
  if [ -d "$home/.claude" ]; then link "$home/.claude/skills" "$skill"; fi
  # Pi can find a skill in more than one place. The user directory has priority,
  # so this link decides which copy Pi loads.
  if [ -d "$home/.pi/agent" ]; then link "$home/.pi/agent/skills" "$skill"; fi
done
if [ "$found" = 0 ]; then
  echo "no skill directory in $src" >&2
  exit 1
fi
echo "Start a new session, or run /reload in pi, to load the skills."
