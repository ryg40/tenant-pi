#!/bin/sh
# Copy Compare session records one way into the root of a Compare mirror.
# Usage: sync.sh DEST_ROOT SOURCE_ROOT...
# A SOURCE_ROOT is a Compare root in rsync form: /home/me/.local/.walkr/compare or host:.local/.walkr/compare
# The script deletes nothing. A changed record replaces its copy. WALKR_MIRROR_OWNER=uid:gid sets the owner (root only).
set -u
[ "$#" -ge 2 ] || { echo "usage: sync.sh DEST_ROOT SOURCE_ROOT..." >&2; exit 2; }
command -v rsync >/dev/null || { echo "sync.sh: rsync is necessary" >&2; exit 2; }
dest=$1; shift
owner=${WALKR_MIRROR_OWNER:-}
umask 077
mkdir -p "$dest/sessions" || exit 1
chmod 700 "$dest" "$dest/sessions" || exit 1
[ -z "$owner" ] || chown "$owner" "$dest" "$dest/sessions" || exit 1
failed=0
for source in "$@"; do
  # Only options that rsync 2.6.9, openrsync (macOS) and rsync 3 all have.
  # The rules copy the session directories of the first level and their session.json, nothing else.
  # A session directory without a record arrives empty; the store skips it like an interrupted create.
  rsync -rt --timeout=20 \
    --include='/*/' --include='/*/session.json' --exclude='*' \
    "${source%/}/sessions/" "$dest/sessions/" || { echo "sync.sh: no copy from $source" >&2; failed=1; }
done
# The store accepts only directories of mode 0700 and records of mode 0600 with the owner of the server.
find "$dest/sessions" -type d -exec chmod 700 {} + || exit 1
find "$dest/sessions" -type f -exec chmod 600 {} + || exit 1
[ -z "$owner" ] || chown -R "$owner" "$dest/sessions" || exit 1
exit "$failed"
