#!/bin/sh
# One optional wrapper boundary for installed launchers and Herdr shell functions.
# The PID marker avoids wrapping twice in the same exec chain, not in later sessions.
if [ "${TENANT_CREDSYNC_PID-}" = "$$" ] || [ ! -f .credsync.json ]; then
    exec "$@"
fi
export TENANT_CREDSYNC_PID=$$
if ! command -v credsync >/dev/null 2>&1; then
    printf '%s\n' 'credsync: credsync is missing; starting unchanged; install credsync' >&2
elif ! command -v fnox >/dev/null 2>&1; then
    printf '%s\n' 'credsync: fnox is missing; starting unchanged; install fnox' >&2
elif ! credsync check >/dev/null 2>&1; then
    printf '%s\n' 'credsync: project file is not approved or cannot be checked; starting unchanged; check the file and approval with the owner' >&2
else
    # --keep-ambient keeps the ambient environment; a later release can drop the flag.
    exec credsync run --fallback --keep-ambient -- "$@"
fi
exec "$@"
