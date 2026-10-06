#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
packages_dir="$(dirname -- "$package_dir")"
kit_root="$(dirname -- "$packages_dir")"
if [[ ! -f "$package_dir/dist/src/sidebar/controller.mjs" ]]; then
  printf '%s\n' 'Build first: cd packages/promptr && npm ci && npm run build' >&2
  exit 1
fi
# Separate settings and Promptr data. No global install or existing notebook writes.
export PI_CODING_AGENT_DIR="${PROMPTR_PREVIEW_AGENT_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/promptr-sidebar-preview}"
mkdir -p -- "$PI_CODING_AGENT_DIR"
# Pi starts in the kit root, the parent of packages/.
cd -- "$kit_root"
# Load the Tenantext footer so the trial checks real footer coexistence.
# PROMPTR_PREVIEW_FOOTER=<path> must exist; PROMPTR_PREVIEW_FOOTER=none runs stock Pi.
# Without it, use $PROMPTR_STACK_DIR/tenantext when PROMPTR_STACK_DIR is set, then the Tenantext package beside this package (packages/tenantext).
footer_args=()
if [[ -n "${PROMPTR_PREVIEW_FOOTER:-}" ]]; then
  footer="$PROMPTR_PREVIEW_FOOTER"
  if [[ "$footer" != none && ! -f "$footer" ]]; then
    printf 'Footer not found: %s (use PROMPTR_PREVIEW_FOOTER=none for stock Pi)\n' "$footer" >&2
    exit 1
  fi
else
  footer=none
  for candidate in ${PROMPTR_STACK_DIR:+"$PROMPTR_STACK_DIR/tenantext/extensions/ops-footer/index.ts"} "$packages_dir/tenantext/extensions/ops-footer/index.ts"; do
    if [[ -f "$candidate" ]]; then footer="$candidate"; break; fi
  done
fi
if [[ "$footer" != none ]]; then
  footer_args=(-e "$footer")
  printf 'Promptr preview footer: %s\n' "$footer" >&2
else
  printf '%s\n' 'Promptr preview footer: stock Pi (Tenantext not loaded)' >&2
fi
# The original editor/footer remain full width below the chat/sidebar split.
exec pi --tui-mode fullscreen --offline --no-session --no-extensions --no-skills -e "$package_dir/index.ts" "${footer_args[@]}" "$@"
