# The Compose seat: image, entrypoint and Compose file

Status: offline implementation, not a qualified runtime. No container of this image has a recorded trial. The term is in [the glossary](../../GLOSSARY.md).

[The Compose seat guide](../../docs/guides/compose-seat.md) has the procedure for the operator: prerequisites, build, login, updates, removal and the qualification table. This document is the reference.

The Compose seat is a container that holds one generated Pi profile for one user. The user reaches it over SSH. This directory holds the image recipe, the sshd configuration, the entrypoint, the shell profile, the Compose files and the templates of the two env files.

| File | Purpose |
| --- | --- |
| `Dockerfile` | The image recipe. |
| `sshd_config` | The sshd configuration. The build writes the account name into it. |
| `entrypoint.sh` | The start program of the container. |
| `profile.sh` | The shell profile of the seat account. The build installs it as `/etc/profile.d/tenant-pi-seat.sh`. |
| `compose.yaml` | The Compose file: one service `seat`. |
| `compose.projects.yaml` | The optional second Compose file: the projects directory. |
| `seat.env.example` | The template of `<private dir>/seat.env`, the variables that Compose reads. |
| `compose.env.example` | The template of `<private dir>/compose.env`, the environment of the container. |
| `../../.dockerignore` | The files that the build context leaves out. |

## Build without Compose

The build context is the kit root, so the build needs no Git access. Run the build on the machine that runs the seat. The Dockerfile names no target architecture.

```sh
cd "$HOME/tenant-pi"
docker build -f deploy/compose/Dockerfile -t tenant-pi-seat \
  --build-arg KIT_COMMIT="$(git rev-parse --short HEAD)" .
```

| Build argument | Default | Meaning |
| --- | --- | --- |
| `SEAT_USER` | `pi` | The account name of the seat. |
| `SEAT_UID` | `1000` | The UID of the account. |
| `SEAT_GID` | `1000` | The GID of the account. |
| `KIT_COMMIT` | `unknown` | The kit commit that the seat build record names. |

The build context has no `.git` directory, so the build cannot read the commit. Give it with `KIT_COMMIT`. The Compose file passes the four build arguments. There, `KIT_COMMIT` is mandatory.

## The two env files

The two files are in the private directory of the operator, not in the checkout. See [the private directory](../../docs/private-directory.md).

| File | Template | Who reads it | Content |
| --- | --- | --- | --- |
| `<private dir>/seat.env` | `seat.env.example` | Compose, through `--env-file`, when it reads the Compose file. | The `SEAT_*` variables. No secret. |
| `<private dir>/compose.env` | `compose.env.example` | The container, through `env_file` of the service. | `TENANTEXT_LITELLM_API_KEY` and `TENANTEXT_LITELLM_BASE_URL`. |

- The split keeps the key out of the file that Compose reads for the Compose file. Do not give `compose.env` to `--env-file`.
- Create `compose.env` with mode 600. The operator pastes the key value into it. Never put a value into `compose.env.example`.
- Put the key value between single quotes in `compose.env`: `TENANTEXT_LITELLM_API_KEY='...'`. Compose interpolates `$` in the file, and an unquoted ` #` starts a comment. Single quotes keep the value literal.
- `TENANTEXT_LITELLM_BASE_URL` in `compose.env` is optional. The launcher holds the URL from the overlay, and a login session does not see the environment of the container.
- `KIT_COMMIT` is in no file, because it changes with the checkout. Give it in each command.
- The private directory also holds `overlay.json`, `authorized_keys` and `registry.json`. The container gets the directory read-only at `/private`.

The `compose-plan` action of `scripts/tenant_pi.py` makes the files of the private directory from the answers of the guided flow. Without `--write` it prints the overlay, the registry, the lines of the two env files and the command lines, and it writes nothing. With `--write` it creates `overlay.json`, `seat.env`, `compose.env`, `authorized_keys` and `registry.json` with mode 600, and it refuses when one of them exists. It runs no command, and it writes no key value: the key line of `compose.env` is empty. See [the offline profile CLI](../../docs/generator.md#compose-plan-the-files-and-the-commands-of-a-compose-seat) and Stage 4c of [the install document](../../INSTALL.md).

```sh
python3 scripts/tenant_pi.py compose-plan --uid "$(id -u)" --gid "$(id -g)" --public-key "$HOME/.ssh/id_ed25519.pub" \
  --gateway-url '<gateway url>' --private-dir "$HOME/.config/tenant-pi" --model codex-auto/astra
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIT_COMMIT` | none, mandatory | `git rev-parse --short HEAD` of the checkout. It is a build argument and the tag of the image `tenant-pi-seat:<commit>`. |
| `SEAT_PRIVATE_DIR` | none, mandatory | The absolute path of the private directory. |
| `SEAT_USER` | `pi` | The account name. It is a build argument and the name of the home directory `/home/<user>`. |
| `SEAT_UID`, `SEAT_GID` | `1000` | The UID and the GID of the account. Use the values of the operator. |
| `SEAT_BIND` | `127.0.0.1` | The address on the machine that receives the SSH connections. |
| `SEAT_SSH_PORT` | `2222` | The port on the machine that receives the SSH connections. |
| `SEAT_USERNS` | empty | Empty for Docker. For Podman: `keep-id:uid=<uid>,gid=<gid>`. |
| `SEAT_KEY_VAR` | `TENANTEXT_LITELLM_API_KEY` | The name of the variable in `compose.env` that holds the gateway key. |
| `SEAT_PROJECTS_DIR` | none | The absolute path of the projects directory. Only `compose.projects.yaml` reads it. |

Warning: `SEAT_BIND=0.0.0.0` opens the seat to the network.

Warning: `docker compose config`, `docker inspect` and `podman inspect` print the key value of `compose.env`. With the `podman-compose` provider, the value is also on a `podman` command line during the start.

## Build and start with Compose

Run each command from the kit root. Each Compose command needs `KIT_COMMIT` and `--env-file`, also `ps`, `logs` and `down`.

```sh
cd "$HOME/tenant-pi"
export KIT_COMMIT="$(git rev-parse --short HEAD)"
docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml build
docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml up -d
docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml logs seat
```

With Podman, the commands are the same with `podman compose`, and `seat.env` holds `SEAT_USERNS=keep-id:uid=<uid>,gid=<gid>`:

```sh
podman compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml build
podman compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml up -d
```

A Compose file has no conditional volume. Thus the projects directory is in a second file. When a projects directory exists, set `SEAT_PROJECTS_DIR` in `seat.env` and give the two files in each command:

```sh
docker compose --env-file "<private dir>/seat.env" \
  -f deploy/compose/compose.yaml -f deploy/compose/compose.projects.yaml up -d
```

### Read in the source of the podman-compose 1.6.0 release; line numbers refer to that release

The table records how `podman_compose.py` reads the keys of the Compose file. Not verified: the runtime behaviour of each key under Podman.

| Key | Source lines | What the source does |
| --- | --- | --- |
| `name:` | 2605 | It is the project name when `-p` and `COMPOSE_PROJECT_NAME` give none. |
| `tmpfs` | 1375-1379 | Each entry goes to `podman` as `--tmpfs <entry>`, with its options. |
| `init` | 1452 | A true value adds `--init`. |
| `restart` | 1447 | The value goes to `podman` as `--restart <value>`. Keep `"no"` in quotes, because YAML reads a bare `no` as false. |
| `${VAR:?}` | 275-276 | The operators `?` and `:?` are in the list of the interpolation operators. |

What the Compose file sets:

- One service `seat`, in the project `tenant-pi-seat`. The build context is the kit root.
- `user: "0:0"`: the entrypoint starts as root, because sshd needs root.
- `init: true`: a small init program is process 1.
- `restart: "no"`: a container that stops stays stopped. Read its log, then start it again.
- The named volume `seat-home` at `/home/<user>` and the named volume `seat-ssh` at `/etc/ssh/keys`. `down` keeps the two volumes. `down -v` removes them, and the seat then gets a new host key.
- The tmpfs `/run/tenant-pi-seat` with `mode=0700`, for the gateway key file.
- No `extra_hosts`, no `platform`, no `network_mode`, no volume option `U`, no `x-podman` key.

## The gateway key

sshd gives no variable of the container to a login session. Thus the key goes through a file in memory:

1. The container gets the variables of `compose.env` and `SEAT_KEY_VAR`.
2. At each start, the root part of the entrypoint reads the variable that `SEAT_KEY_VAR` names. A name that is not a variable name stops the start.
3. When the value is not empty, the seat account writes it to `/run/tenant-pi-seat/gateway-key`, without a line end, and writes the name of the variable to `/run/tenant-pi-seat/gateway-key.name`. The directory has the mode 0700. Each file has the mode 0400. The seat account owns the three. The value goes through a pipe, not through a command line.
4. When the value is empty, the entrypoint prints one line and continues. A seat without a key is correct for a provider with a native login.
5. `/etc/profile.d/tenant-pi-seat.sh` exports the variable from the two files in each shell of the seat account, when the files are readable.

The seat uses no `AcceptEnv`, no `SetEnv`, no `/etc/environment` and no edit of `~/.profile` for the key. No program of the seat reads `/private/compose.env`. The launcher `~/.local/bin/pi-profile` holds the gateway URL from the overlay and no key. See [the launcher file](../../docs/launcher.md).

## Login

```sh
ssh -p 2222 pi@127.0.0.1
```

- An interactive SSH login starts the tmux session `seat`, or attaches to it: `tmux new-session -A -s seat`. The conditions are: the shell is interactive, `SSH_CONNECTION` is set, `TMUX` is empty, the standard input is a terminal, and `tmux` is there.
- When tmux ends without an error, the login ends. When tmux fails, the profile prints one line and the login shell stays.
- The image has the terminal descriptions of `ncurses-base` only. When `infocmp "$TERM"` fails, for example with the `TERM` of Ghostty or kitty, the profile prints the original value and sets `TERM=xterm-256color`.
- The working directory of a new session is `/projects` when the projects directory is there, else the home directory.
- A command login (`ssh -p 2222 pi@127.0.0.1 <command>`) starts no tmux. It gets the `PATH` and the key variable.
- Start Pi with `pi-profile`. To use Herdr, run `herdr` in the tmux session, then run `pi-profile` in a Herdr pane.
- The image holds no Herdr defaults file, and the entrypoint writes no `~/.config/herdr/config.toml`. Not verified: whether Herdr 0.9.3 has a configuration key for a default agent command.
- `scp` and `sftp` do not work: `sshd_config` has no `Subsystem sftp` line. Copy a file through the projects directory, or with `ssh -p 2222 pi@127.0.0.1 'cat > <file>' < <file>`.

## What the image holds

- The base image `node:24-trixie-slim`, pinned by tag and digest.
- The Debian packages `python3`, `python3-venv`, `git`, `curl`, `ca-certificates`, `openssh-server`, `tmux` and `less`.
- Herdr 0.9.3 as `/usr/local/bin/herdr`. The build selects the asset by architecture (`x86_64` or `aarch64`) and checks its SHA-256.
- The reviewed source of the Herdr application is the open-source project `herdrdev/herdr` on GitHub, with the license Apache-2.0. See [INSTALL.md, Stage 4a](../../INSTALL.md#stage-4a-herdr-and-the-question-tool).
- The seat account, with a `*` password field, without a sudo group and without a docker group. The build removes the base image account that holds `SEAT_UID`. When a group holds `SEAT_GID`, the account uses that group.
- The kit at `/opt/tenant-pi`, owned by the seat account. The build runs the four offline checks there. A failure stops the build.
- The Pi version of `runtime.piVersion` in `config/manifest.json`, installed by the seat account with `npm install --global --prefix /opt/pi-npm`.
- The dependencies of `packages/tenantext` (`npm ci --ignore-scripts`).
- `/opt/tenant-pi/.seat-build`, the seat build record, with the two lines `kit_commit=<value>` and `pi_version=<pin>`.
- No SSH host key.

The base image and the Debian packages have their own licences; the kit does not redistribute the image.

The Pi prefix is `/opt/pi-npm`, not a directory of the home. A home volume keeps its first content. A prefix in the home would keep the old Pi after a new image build. A Pi self-update inside the container lives in the container layer, and a recreate of the container loses it.

The image owns the profile text in `/etc/profile.d/tenant-pi-seat.sh`, a copy of `profile.sh`: the `PATH` with `$HOME/.local/bin` and `/opt/pi-npm/bin`, the export of the gateway key, and the tmux session of a login. `.profile` and `.bashrc` of the seat account read that file. The kit rule "never edit a shell startup file" is for the machine of a user, not for an image that the kit builds.

## sshd

sshd listens on port 2222. It accepts only a public key, and only for the seat account (`AllowUsers`). Root login, password login and keyboard-interactive login are off. `UsePAM` is `no`. The file has no `AcceptEnv` line.

## What the entrypoint does

The entrypoint starts as root. It prints one line for each step.

1. It creates the ed25519 host key in `/etc/ssh/keys` when the key is absent.
2. It stops with exit code 1 when `/private/authorized_keys` is absent or holds no key line. A key line is not empty and is not a comment.
3. It gives the top of the home directory to the seat account.
4. It copies `/private/authorized_keys` to `~/.ssh/authorized_keys` of the seat account. Root reads the source, and the seat account writes the copy.
5. It writes the gateway key file in `/run/tenant-pi-seat`, or it prints that the seat has no key. See "The gateway key".
6. It runs the profile steps as the seat account, with `runuser`.
7. It starts `sshd -D -e` in the foreground.

The profile steps depend on the state of `~/.pi/profiles/main`:

| State | Steps |
| --- | --- |
| The profile is absent. | `check-runtime`, `validate`, `plan` and `generate` with `/private/overlay.json`. Then the entrypoint copies the seat build record to `~/.tenant-pi/seat-build`. A failure stops the container. |
| The profile exists, `~/.tenant-pi/seat-build` is absent, and the status in `.tenant-pi/state.json` of the profile is not `complete`. | None. The entrypoint prints `seat: main: the profile <dir> is incomplete; remove it and start again` and stops with exit code 1. |
| The profile exists and is complete, and `~/.tenant-pi/seat-build` is absent. | The entrypoint keeps the profile and copies the seat build record to `~/.tenant-pi/seat-build`. |
| The profile exists, and the two seat build records are equal. | None. |
| The profile exists, and the two records differ. | The same four steps into `~/.pi/profiles/candidate-<kit_commit>-<pi_version>`. Then the entrypoint prints the steps of [the candidate update guide](../../docs/guides/candidate-update.md). A failure does not stop the container. |

- The entrypoint never writes into a profile directory that exists. `generate` refuses an existing target too.
- `/private` is read-only. The entrypoint writes the runtime report, the output of each step and `install-log.md` to `~/.tenant-pi`. It writes the launcher to `~/.local/bin/pi-profile`.
- `--registry /private/registry.json` is in the commands only when the file exists.
- `--local-dir /private` is in the commands only when the overlay enables `mcp`.
- `generate` needs an overlay that names its target. For a candidate, the entrypoint writes a copy of the overlay to `~/.tenant-pi/`, with only `target.agentDir` changed.
- The name of a candidate is `candidate-<kit_commit>-<pi_version>`. Both values come from `/opt/tenant-pi/.seat-build`. A value that is empty or has a character outside `A-Za-z0-9._-` becomes `unknown`. Thus a new Pi pin gives a new candidate when the kit commit is `unknown`.
- The launcher of a candidate is `~/.local/bin/pi-profile-candidate-<kit_commit>-<pi_version>`.
- The `--seat-account` command of the entrypoint runs the profile steps only when the UID is the UID of the seat account. For each other UID it prints one line and stops with exit code 1.
- The entrypoint offers the candidate at each start until the two records are equal. To end the offer after the switch, copy `/opt/tenant-pi/.seat-build` to `~/.tenant-pi/seat-build`.

## Limits

- Not verified: a start of the container, a login, the tmux session of a login, the key variable in a login session, and each behaviour under Podman.
- Not verified: the tmpfs option `mode=0700` with the `podman-compose` provider. The entrypoint sets the mode and the owner of the directory at each start, so the seat does not depend on the option.
- `ComposeConfigTests` in [tests/test_compose_seat.py](../../tests/test_compose_seat.py) runs `docker compose config` on both Compose files when `docker compose` is present. Not run in this document: a build or a start.
- `scripts/publish_check.py` fails inside the image after the build, because `/opt/tenant-pi/.seat-build` is not in the publish set. The build runs the check before it writes the record.
- The kit commit in `.tenant-pi/state.json` of a profile is `unknown`, because the image has no Git metadata. The seat build record holds the commit.
- sshd does not give the environment of the container to a login session. Only the gateway key reaches a login session, through the key file. `TENANTEXT_LITELLM_BASE_URL` of `compose.env` does not: the launcher holds the URL.
- The profile steps of the entrypoint run with the environment of the container, so they can read the key variable.
- Not verified: the login shell that stays after a tmux failure, and the `TERM` fallback, in a container. The tests run the function `seat_tmux` of `profile.sh` under `dash` with a stub `tmux`.
- The image builds no other package. A profile with `promptr` needs the build of `packages/promptr` in the checkout before the image build.
