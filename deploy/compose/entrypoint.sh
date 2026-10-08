#!/bin/sh
# Entrypoint of the Compose seat.
# It starts as root: the host key, the authorized keys, the owner of the home directory,
# the gateway key file.
# It runs the profile steps as the seat account, then it starts sshd in the foreground.
# It prints one line for each step. It never writes into a profile directory that exists.
set -eu

KIT=/opt/tenant-pi
PRIVATE=/private
HOST_KEY=/etc/ssh/keys/ssh_host_ed25519_key
# The Compose file makes this directory a tmpfs. It holds the gateway key file.
KEY_DIR=/run/tenant-pi-seat
# The image build writes this file. It holds the line SEAT_USER=<account name>.
. /etc/tenant-pi-seat/seat.conf
SEAT_HOME="/home/$SEAT_USER"

say() {
    printf 'seat: %s\n' "$*"
}

# The steps of the seat account. The private directory is read-only, so each write goes
# to the home directory: the records to ~/.tenant-pi, the launcher to ~/.local/bin.
record() {
    say "$*"
    printf -- '- %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$STATE/install-log.md"
}

# make_profile <name> <overlay file> <target directory> <launcher file>
# INSTALL.md Stages 5 and 6: check-runtime, validate, plan, generate.
# The exit code is 0 when the target holds a complete profile.
make_profile() {
    name=$1 overlay=$2 target=$3 launcher=$4

    # The guard: generate runs only for a target that is absent.
    if [ -e "$target" ] || [ -L "$target" ]; then
        record "$name generate: skipped, $target exists"
        return 1
    fi

    # Exit code 1 of check-runtime is a finding, not a failure. The file holds the report.
    code=0
    python3 scripts/tenant_pi.py check-runtime > "$STATE/runtime.json" || code=$?
    if [ "$code" -gt 1 ]; then
        record "$name check-runtime: failed, exit code $code"
        return 1
    fi
    record "$name check-runtime: exit code $code, report $STATE/runtime.json"

    set -- --overlay "$overlay"
    if [ -f "$PRIVATE/registry.json" ]; then
        set -- "$@" --registry "$PRIVATE/registry.json"
    fi
    # The mcp component reads its input file from the private directory.
    if python3 -c 'import json, sys
sys.exit(0 if "mcp" in json.load(open(sys.argv[1]))["selection"]["enable"] else 1)' "$overlay" 2>/dev/null; then
        set -- "$@" --local-dir "$PRIVATE"
    fi

    code=0
    python3 scripts/tenant_pi.py validate "$@" > "$STATE/$name-validate.json" || code=$?
    if [ "$code" -ne 0 ]; then
        record "$name validate: failed, exit code $code, output $STATE/$name-validate.json"
        return 1
    fi
    record "$name validate: passed"

    set -- "$@" --runtime-report "$STATE/runtime.json" --launcher "$launcher"
    code=0
    python3 scripts/tenant_pi.py plan "$@" > "$STATE/$name-plan.json" || code=$?
    if [ "$code" -ne 0 ]; then
        record "$name plan: failed, exit code $code, output $STATE/$name-plan.json"
        return 1
    fi
    record "$name plan: written to $STATE/$name-plan.json"

    code=0
    python3 scripts/tenant_pi.py generate "$@" --target "$target" > "$STATE/$name-generate.json" || code=$?
    if [ "$code" -eq 0 ]; then
        record "$name generate: profile $target, launcher $launcher"
        return 0
    fi
    # Exit code 1 with a complete profile: the launcher file is the part that failed.
    if [ "$code" -eq 1 ] && grep -q '"filesComplete": *true' "$STATE/$name-generate.json"; then
        record "$name generate: profile $target is complete, the launcher failed, output $STATE/$name-generate.json"
        return 0
    fi
    record "$name generate: failed, exit code $code, output $STATE/$name-generate.json"
    return 1
}

# build_value <key>
# It prints one value of the seat build record of the image, as a safe part of a file name.
build_value() {
    value="$(sed -n "s/^$1=//p" "$KIT/.seat-build" | head -n 1)"
    case "$value" in
        ""|*[!A-Za-z0-9._-]*) value=unknown ;;
    esac
    printf '%s\n' "$value"
}

# profile_complete <profile directory>
# The exit code is 0 only when the state file of the profile has the status "complete".
profile_complete() {
    python3 -c 'import json, sys
sys.exit(0 if json.load(open(sys.argv[1]))["status"] == "complete" else 1)' \
        "$1/.tenant-pi/state.json" 2>/dev/null
}

seat_account_steps() {
    HOME=$SEAT_HOME
    export HOME
    . /etc/profile.d/tenant-pi-seat.sh
    umask 077
    STATE="$HOME/.tenant-pi"
    main="$HOME/.pi/profiles/main"
    mkdir -p "$STATE" "$HOME/.local/bin" "$HOME/.pi/profiles"
    cd "$KIT"

    if [ ! -e "$main" ] && [ ! -L "$main" ]; then
        # First start: generate the profile from the overlay of the private directory.
        if [ ! -f "$PRIVATE/overlay.json" ]; then
            record "main: failed, $PRIVATE/overlay.json is absent"
            exit 1
        fi
        make_profile main "$PRIVATE/overlay.json" "$main" "$HOME/.local/bin/pi-profile" || exit 1
        cp "$KIT/.seat-build" "$STATE/seat-build"
        record "main seat-build: recorded in $STATE/seat-build"
        return 0
    fi

    if [ ! -f "$STATE/seat-build" ]; then
        # No record of a build. A generation that failed leaves a profile that is not complete.
        if ! profile_complete "$main"; then
            record "main: the profile $main is incomplete; remove it and start again"
            exit 1
        fi
        cp "$KIT/.seat-build" "$STATE/seat-build"
        record "main: kept, the profile is complete, seat-build recorded in $STATE/seat-build"
        return 0
    fi

    if cmp -s "$KIT/.seat-build" "$STATE/seat-build"; then
        record "main: kept, the image build is the build of the profile"
        return 0
    fi

    # The profile exists and the image build differs: offer a candidate beside the profile.
    # A candidate failure does not stop the seat. The live profile stays as it is.
    # The name holds the kit commit and the Pi pin, so a new pin gives a new candidate
    # when the build has no kit commit.
    name="candidate-$(build_value kit_commit)-$(build_value pi_version)"
    candidate="$HOME/.pi/profiles/$name"
    launcher="$HOME/.local/bin/pi-profile-$name"
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
        record "$name: kept, $candidate exists"
    else
        # generate needs an overlay that names its target. The private overlay names the live
        # profile, so the candidate gets a copy with only target.agentDir changed.
        code=0
        python3 -c 'import json, sys
data = json.load(open(sys.argv[1]))
data["target"]["agentDir"] = sys.argv[3]
json.dump(data, open(sys.argv[2], "w"), indent=2)' \
            "$PRIVATE/overlay.json" "$STATE/$name-overlay.json" "$candidate" 2>/dev/null || code=$?
        if [ "$code" -ne 0 ]; then
            record "$name overlay: failed, $PRIVATE/overlay.json is absent or is not an overlay"
            return 0
        fi
        record "$name overlay: written to $STATE/$name-overlay.json"
        make_profile "$name" "$STATE/$name-overlay.json" "$candidate" "$launcher" || return 0
    fi
    say "$name: the image build differs from the build of the live profile $main"
    say "$name: follow $KIT/docs/guides/candidate-update.md from Step 3"
    say "$name: 1. compare: python3 $KIT/scripts/tenant_pi.py compare --left $main --right $candidate"
    say "$name: 2. reconcile: carry, accept or drop each difference"
    say "$name: 3. set up: the candidate authenticates and installs its declared packages on its own"
    say "$name: 4. switch: run $launcher"
    say "$name: 5. end this offer: cp $KIT/.seat-build $STATE/seat-build"
}

if [ "${1:-}" = --seat-account ]; then
    # The root part gives this command to runuser. No other account runs the seat steps.
    if [ "$(id -u)" != "$(id -u "$SEAT_USER")" ]; then
        say "seat account: failed, only the account $SEAT_USER runs the seat steps"
        exit 1
    fi
    seat_account_steps
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    say "start: failed, the entrypoint must start as root"
    exit 1
fi
seat_uid="$(id -u "$SEAT_USER")"
seat_gid="$(id -g "$SEAT_USER")"

mkdir -p /etc/ssh/keys
chmod 0700 /etc/ssh/keys
if [ ! -f "$HOST_KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -f "$HOST_KEY"
    say "host key: created"
else
    say "host key: kept"
fi

if [ ! -f "$PRIVATE/authorized_keys" ]; then
    say "authorized_keys: failed, $PRIVATE/authorized_keys is absent"
    exit 1
fi
# A key line is a line that is not empty and is not a comment.
if ! grep -q '^[[:space:]]*[^#[:space:]]' "$PRIVATE/authorized_keys"; then
    say "authorized_keys: failed, $PRIVATE/authorized_keys holds no key line"
    exit 1
fi
# Only the top directory. A volume can give the mount point to root at its first use.
chown "$seat_uid:$seat_gid" "$SEAT_HOME"
say "home: $SEAT_HOME belongs to $seat_uid:$seat_gid"
# Root opens the source. The seat account writes the copy, so root follows no link in the home.
runuser -u "$SEAT_USER" -- sh -c '
    umask 077
    mkdir -p "$1/.ssh" && chmod 0700 "$1/.ssh" || exit 1
    rm -f "$1/.ssh/authorized_keys.new"
    cat > "$1/.ssh/authorized_keys.new" && chmod 0600 "$1/.ssh/authorized_keys.new" || exit 1
    mv -f "$1/.ssh/authorized_keys.new" "$1/.ssh/authorized_keys"
' sh "$SEAT_HOME" < "$PRIVATE/authorized_keys"
say "authorized_keys: copied to $SEAT_HOME/.ssh/authorized_keys"

# The gateway key. sshd gives no variable of the container to a login session, so the key
# goes to a file that only the seat account reads. The shell profile of the image reads the file.
# SEAT_KEY_VAR is the name of the variable that holds the key. Each start writes the two files again.
install -d -m 0700 -o "$seat_uid" -g "$seat_gid" "$KEY_DIR"
rm -f "$KEY_DIR/gateway-key" "$KEY_DIR/gateway-key.name"
key_name="${SEAT_KEY_VAR:-TENANTEXT_LITELLM_API_KEY}"
case "$key_name" in
    [!A-Za-z_]*|*[!A-Za-z0-9_]*)
        say "gateway key: failed, SEAT_KEY_VAR is not the name of a variable"
        exit 1
        ;;
esac
eval "key_value=\${$key_name-}"
if [ -n "$key_value" ]; then
    # The value goes through the standard input, not through a command line.
    # The seat account writes the two files, so root follows no link in the directory.
    printf '%s' "$key_value" | runuser -u "$SEAT_USER" -- sh -c '
        umask 077
        printf "%s\n" "$2" > "$1/gateway-key.name" && chmod 0400 "$1/gateway-key.name" || exit 1
        cat > "$1/gateway-key" && chmod 0400 "$1/gateway-key"
    ' sh "$KEY_DIR" "$key_name"
    say "gateway key: written to $KEY_DIR/gateway-key, the variable is $key_name"
else
    say "gateway key: none, the variable $key_name is empty; a provider with a native login needs no key"
fi
unset key_value

mkdir -p /run/sshd
runuser -u "$SEAT_USER" -- "$0" --seat-account

say "sshd: start on port 2222"
exec /usr/sbin/sshd -D -e
