# Image of the Compose seat: one Pi profile for one user, reached over SSH.
# The build context is the kit root:
#   docker build -f deploy/compose/Dockerfile -t tenant-pi-seat .
# The file names no target architecture. Build on the machine that runs the seat.

# Digest of the tag on 2026-10-07. It is the digest of the image index, for amd64 and arm64.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66

ARG SEAT_USER=pi
ARG SEAT_UID=1000
ARG SEAT_GID=1000
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv git curl ca-certificates openssh-server tmux less \
 && rm -rf /var/lib/apt/lists/*

# Herdr 0.9.3. Each SHA-256 is the digest that the GitHub release API gives for the asset.
# The project publishes no separate checksum file.
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
 && case "$arch" in \
      amd64) asset=herdr-linux-x86_64; sum=18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7 ;; \
      arm64) asset=herdr-linux-aarch64; sum=4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0 ;; \
      *) echo "seat build: no Herdr asset for the architecture $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSLo /usr/local/bin/herdr \
      "https://github.com/herdrdev/herdr/releases/download/v0.9.3/${asset}" \
 && echo "${sum}  /usr/local/bin/herdr" | sha256sum -c - \
 && chmod 755 /usr/local/bin/herdr

# The seat account. It has no password, no sudo group and no docker group.
# The base image has an account with the UID 1000. The build removes the account that holds SEAT_UID.
# A group that holds SEAT_GID stays, and the seat account uses it.
# usermod sets the password field to "*": with "UsePAM no", sshd refuses a key login to a locked ("!") account.
RUN case "$SEAT_USER" in ""|[!a-z_]*|*[!a-z0-9_-]*) echo "seat build: SEAT_USER is not a plain account name" >&2; exit 1 ;; esac \
 && case "$SEAT_UID$SEAT_GID" in ""|*[!0-9]*) echo "seat build: SEAT_UID and SEAT_GID are numbers" >&2; exit 1 ;; esac \
 && if [ "$SEAT_UID" -eq 0 ] || [ "$SEAT_USER" = root ]; then echo "seat build: the seat account is not root" >&2; exit 1; fi \
 && old="$(getent passwd "$SEAT_UID" | cut -d: -f1)" \
 && if [ -n "$old" ]; then userdel -r "$old"; fi \
 && if ! getent group "$SEAT_GID" >/dev/null; then groupadd -g "$SEAT_GID" "$SEAT_USER"; fi \
 && useradd -u "$SEAT_UID" -g "$SEAT_GID" -m -d "/home/${SEAT_USER}" -s /bin/bash "$SEAT_USER" \
 && usermod -p '*' "$SEAT_USER" \
 && mkdir -p /etc/tenant-pi-seat \
 && printf 'SEAT_USER=%s\n' "$SEAT_USER" > /etc/tenant-pi-seat/seat.conf

# The shell profile of the seat account: the PATH, the gateway key and the tmux session of a login.
# The kit rule "never edit a shell startup file" is for the machine of a user.
# It does not apply to an image that the kit builds, so the build writes the lines below.
# The image owns the profile text in /etc/profile.d. The home volume keeps .profile and .bashrc,
# and the two files only read that text. Thus a new image changes the profile of an old home volume.
# .bashrc reads it first, before the line that stops a shell without a terminal.
COPY --chmod=644 deploy/compose/profile.sh /etc/profile.d/tenant-pi-seat.sh
RUN line='[ -r /etc/profile.d/tenant-pi-seat.sh ] && . /etc/profile.d/tenant-pi-seat.sh' \
 && home="/home/${SEAT_USER}" \
 && { printf '%s\n' "$line"; cat /etc/skel/.bashrc; } > "$home/.bashrc" \
 && printf '%s\n' "$line" >> "$home/.profile" \
 && chown "${SEAT_UID}:${SEAT_GID}" "$home/.bashrc" "$home/.profile"

# The kit checkout is the build context. See .dockerignore at the kit root.
COPY --chown=${SEAT_UID}:${SEAT_GID} . /opt/tenant-pi
WORKDIR /opt/tenant-pi

# The four offline checks of the kit. A failure stops the build.
RUN runuser -u "$SEAT_USER" -- env PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q \
 && runuser -u "$SEAT_USER" -- env PYTHONDONTWRITEBYTECODE=1 python3 scripts/examples.py \
 && runuser -u "$SEAT_USER" -- env PYTHONDONTWRITEBYTECODE=1 python3 scripts/validate.py --overlay config/config.example.json \
 && runuser -u "$SEAT_USER" -- env PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py

# The pinned Pi, with the Node of the image: the prefix form of INSTALL.md Stage 3.
# The pin is runtime.piVersion of config/manifest.json. The build never runs "npm config set prefix".
# The prefix is outside the home directory. A home volume keeps its first content,
# so a prefix in the home would keep the old Pi after a new image build.
# The seat build record names the kit commit and the Pi pin of this image.
ARG KIT_COMMIT=unknown
RUN pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" \
 && install -d -o "$SEAT_UID" -g "$SEAT_GID" /opt/pi-npm \
 && runuser -u "$SEAT_USER" -- env npm_config_cache=/tmp/seat-npm-cache npm_config_update_notifier=false \
      npm install --global --prefix /opt/pi-npm -- @earendil-works/pi-coding-agent@"${pin:?}" \
 && printf 'kit_commit=%s\npi_version=%s\n' "$KIT_COMMIT" "$pin" > /opt/tenant-pi/.seat-build \
 && chown "${SEAT_UID}:${SEAT_GID}" /opt/tenant-pi/.seat-build \
 && rm -rf /tmp/seat-npm-cache

# The package dependencies of INSTALL.md Stage 4.
WORKDIR /opt/tenant-pi/packages/tenantext
RUN runuser -u "$SEAT_USER" -- env npm_config_cache=/tmp/seat-npm-cache npm_config_update_notifier=false \
      npm ci --ignore-scripts \
 && rm -rf /tmp/seat-npm-cache
WORKDIR /opt/tenant-pi

# sshd. The image holds no host key: the entrypoint makes one in the key volume.
COPY deploy/compose/sshd_config /etc/ssh/sshd_config
COPY --chmod=755 deploy/compose/entrypoint.sh /usr/local/bin/seat-entrypoint
RUN rm -f /etc/ssh/ssh_host_* \
 && mkdir -p /run/sshd /etc/ssh/keys \
 && chmod 0700 /etc/ssh/keys \
 && sed -i "s/@SEAT_USER@/${SEAT_USER}/" /etc/ssh/sshd_config \
 && chmod 644 /etc/ssh/sshd_config

EXPOSE 2222
# The entrypoint starts as root. It runs the profile steps as the seat account, then it starts sshd.
ENTRYPOINT ["/usr/local/bin/seat-entrypoint"]
