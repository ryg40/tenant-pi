#!/usr/bin/env bash
# claude1 and claude2: start Claude Code with the login of one claude-account slot.
# See packages/tenantext/docs/claude-accounts.md.
#
# Both commands use the settings, plugins, skills, hooks, memory, MCP servers and sessions of plain `claude`.
# Only the login is different.
#
# claude-slot.mjs, beside the real path of this script, makes every check before any change. It refuses when the
# state file of the store or the live login does not agree with the slot. Then:
# - The active slot (`active` in the state file of the store) is the live login in ~/.claude.
#   Its command starts plain `claude`. So one login is never used from two files.
# - The other slot starts with CLAUDE_CONFIG_DIR=<slot folder>. Before each start, the helper links each entry of
#   ~/.claude into the slot folder, except the login files. It copies ~/.claude.json into <slot folder>/.claude.json
#   and keeps the oauthAccount of the slot.
#
# The `claude` on PATH starts, so a wrapper of `claude` on PATH still applies. Only a shell `exec` replaces this
# process, so the start stays here.
# Started under another name, the first argument is the slot: claude-slot.sh 1 [claude arguments].
set -euo pipefail

name=$(basename -- "$0")
case "$name" in
  claude1) slot=1 ;;
  claude2) slot=2 ;;
  *) slot=${1:-}; shift || true ;;
esac
case "$slot" in 1 | 2) ;; *) echo "usage: claude1|claude2 [claude arguments]" >&2; exit 2 ;; esac

# The real folder of this script: ~/.local/bin/claude1 and claude2 are links to it.
self=$0
while [ -L "$self" ]; do
  target=$(readlink -- "$self")
  case "$target" in /*) self=$target ;; *) self=$(dirname -- "$self")/$target ;; esac
done
here=$(cd -P -- "$(dirname -- "$self")" && pwd)

command -v node >/dev/null 2>&1 || { echo "$name: node is not on PATH. claude1 and claude2 need Node.js. Nothing was changed." >&2; exit 1; }
decision=$(node "$here/claude-slot.mjs" "$name" "$slot") || exit 1

export CLAUDE_ACCOUNT_SLOT="$slot"
if [ "$decision" = live ]; then
  # The live login is this account. A config folder of the caller must not apply.
  unset CLAUDE_CONFIG_DIR
else
  export CLAUDE_CONFIG_DIR="$decision"
fi
exec claude "$@"
