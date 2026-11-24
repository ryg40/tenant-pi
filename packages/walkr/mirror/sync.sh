#!/bin/sh
# Copy Walkr Compare session records one way into the root of a read-only mirror.
# Usage: sync.sh DEST_ROOT NAME=HOME...
#   NAME is a name of the computer for the notes of this script. HOME is its home directory in rsync form: /home/me
#   or desk.example:
#   From HOME the script copies the Compare sessions (.local/.walkr/compare/sessions) to DEST_ROOT/sessions.
# Old form, still accepted: sync.sh DEST_ROOT SOURCE_COMPARE_ROOT... copies the Compare sessions of that root.
# NAME=HOME form: a computer without Compare sessions yet gives a note; a computer that does not answer makes the
# exit code 1. Old form: a Compare root that is gone makes the exit code 1.
# The script deletes nothing. A changed record replaces its copy. It never copies server.json, server.lock or a
# token. The records of the retired modes (Core, Double, Coinflip, Trainer) are not copied; an older copy of them
# in DEST_ROOT/hosts stays where it is and is not read. WALKR_MIRROR_OWNER=uid:gid sets the owner (root only).
set -u
usage="usage: sync.sh DEST_ROOT NAME=HOME... (old form: sync.sh DEST_ROOT SOURCE_COMPARE_ROOT...)"
[ "$#" -ge 2 ] || { echo "$usage" >&2; exit 2; }
command -v rsync >/dev/null || { echo "sync.sh: rsync is necessary" >&2; exit 2; }
dest=$1; shift
owner=${WALKR_MIRROR_OWNER:-}
umask 077
mkdir -p "$dest/sessions" || exit 1
chmod 700 "$dest" "$dest/sessions" || exit 1
[ -z "$owner" ] || chown "$owner" "$dest" "$dest/sessions" || exit 1
failed=0

# A sessions folder that does not exist yet (rsync exit 23) is no failure: that computer has no session.
optional() {
  label=$1; shift
  rsync "$@"
  code=$?
  case $code in
    0) ;;
    23|24) echo "sync.sh: nothing copied for $label (no such directory or file yet)" >&2 ;;
    *) echo "sync.sh: no copy of $label (rsync exit $code)" >&2; failed=1 ;;
  esac
}

# Only options that rsync 2.6.9, openrsync (macOS) and rsync 3 all have.
# The rules copy the session directories of the first level and their session.json, nothing else.
# A session directory without a record arrives empty; the store skips it like an interrupted create.
copy_compare() {
  # Old form: the argument names the Compare root itself, so a missing root is a wrong argument and fails the run.
  rsync -rt --timeout=20 \
    --include='/*/' --include='/*/session.json' --exclude='*' \
    -- "${1%/}/sessions/" "$dest/sessions/" || { echo "sync.sh: no Compare copy from $1" >&2; failed=1; }
}

for source in "$@"; do
  case $source in
    *=*) ;;
    *) copy_compare "$source"; continue ;;
  esac
  name=${source%%=*}
  home=${source#*=}
  case $name in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) echo "sync.sh: '$name' is not a valid computer name (letters, digits, '.', '_', '-')" >&2; failed=1; continue ;;
  esac
  # A remote home is "host:"; a path after the colon, or a local path, takes a slash before the parts.
  case $home in
    *:) base=$home ;;
    *) base=${home%/}/ ;;
  esac
  # A computer without Compare sessions yet (rsync exit 23 or 24) gives a note.
  optional "$name Compare" -rt --timeout=20 \
    --include='/*/' --include='/*/session.json' --exclude='*' \
    -- "${base}.local/.walkr/compare/sessions/" "$dest/sessions/"
done
# The store accepts only directories of mode 0700 and records of mode 0600 with the owner of the server.
for part in "$dest/sessions"; do
  [ -d "$part" ] || continue
  chmod 700 "$part" || exit 1
  find "$part" -type d -exec chmod 700 {} + || exit 1
  find "$part" -type f -exec chmod 600 {} + || exit 1
  [ -z "$owner" ] || chown -R "$owner" "$part" || exit 1
done
exit "$failed"
