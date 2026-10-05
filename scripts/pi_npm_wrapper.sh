#!/bin/sh
# Pi `npmCommand` wrapper: run the real package manager, then reapply the peer overrides.
# settings.json: "npmCommand": ["/ABSOLUTE/PATH/pi_npm_wrapper.sh", "--", "npm"]
# Pi captures stdout of lookup commands, so this wrapper writes only to stderr.
[ "$1" = "--" ] && shift
[ "$#" -gt 0 ] || { echo "pi_npm_wrapper: no package manager command" >&2; exit 2; }
"$@"
status=$?
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch=${PI_PEER_PATCH:-$here/patch_extension_peers.mjs}
[ -f "$patch" ] || patch=$here/patch-extension-peers.mjs
# Find the tree that the command changed: Pi passes --prefix (npm) or --cwd (bun).
root=
previous=
for argument in "$@"; do
  case "$previous" in --prefix|--cwd) root=$argument ;; esac
  previous=$argument
done
case " $* " in
  *" install "*|*" i "*|*" add "*|*" update "*|*" uninstall "*|*" remove "*)
    if [ -f "$patch" ]; then
      node "$patch" ${root:+"$root"} >&2 || echo "pi_npm_wrapper: peer override failed; run it by hand" >&2
    else
      echo "pi_npm_wrapper: peer override script not found" >&2
    fi ;;
esac
exit "$status"
