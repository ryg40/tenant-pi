#!/bin/sh
# Copy Walkr session records one way into the root of a history mirror.
# Usage: sync.sh DEST_ROOT NAME=HOME...
#   NAME is the name of the computer on the page. HOME is its home directory in rsync form: /home/me or desk.example:
#   From HOME the script copies the Compare sessions (.local/.walkr/compare/sessions) to DEST_ROOT/sessions, and
#   .human-review/state.json, the Double archive (.local/.walkr/double) and the Trainer datasets (.local/.walkr/trainer)
#   to DEST_ROOT/hosts/NAME/{core,double,trainer}.
# Old form, still accepted: sync.sh DEST_ROOT SOURCE_COMPARE_ROOT... copies the Compare sessions only.
# NAME=HOME form: a part that does not exist yet on a computer gives a note; a computer that does not answer makes the
# exit code 1. Old form: a Compare root that is gone makes the exit code 1.
# The script deletes nothing. A changed record replaces its copy. It never copies server.json, server.lock, a token,
# pristine/, review copies or the shared GUI record. WALKR_MIRROR_OWNER=uid:gid sets the owner (root only).
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

# A part of a computer that does not exist yet (rsync exit 23) is no failure: that computer has no such session.
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
  # A computer without Compare sessions yet (rsync exit 23 or 24) gives a note, as for the other parts.
  optional "$name Compare" -rt --timeout=20 \
    --include='/*/' --include='/*/session.json' --exclude='*' \
    -- "${base}.local/.walkr/compare/sessions/" "$dest/sessions/"
  host="$dest/hosts/$name"
  mkdir -p "$host/core" "$host/double" "$host/trainer" || exit 1
  # Core: the state file only. Never server.json, server.lock, pristine/ or staged pastes.
  optional "$name Core" -t --timeout=20 -- "${base}.human-review/state.json" "$host/core/state.json"
  # Double and Coinflip: the comparison and session records only. Not the shared GUI record (it names the Pi chat),
  # not the Trainer GUI starts and not the temporary files of a writer.
  optional "$name Double" -rt --timeout=20 \
    --include='/double-*.json' --include='/coinflip-session-*.json' --exclude='*' \
    -- "${base}.local/.walkr/double/" "$host/double/"
  # Trainer: <repo>/dataset/<session>/dataset.json, nothing else.
  optional "$name Trainer" -rt --timeout=20 \
    --include='/*/' --include='/*/dataset/' --include='/*/dataset/*/' --include='/*/dataset/*/dataset.json' --exclude='*' \
    -- "${base}.local/.walkr/trainer/" "$host/trainer/"
done
# The stores accept only directories of mode 0700 and records of mode 0600 with the owner of the server.
for part in "$dest/sessions" "$dest/hosts"; do
  [ -d "$part" ] || continue
  chmod 700 "$part" || exit 1
  find "$part" -type d -exec chmod 700 {} + || exit 1
  find "$part" -type f -exec chmod 600 {} + || exit 1
  [ -z "$owner" ] || chown -R "$owner" "$part" || exit 1
done
exit "$failed"
