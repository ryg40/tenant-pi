# Compose seat guide

Scope: one Compose seat on one machine, with Docker Compose on Linux or with Podman on macOS on Apple silicon. Each runtime stays **Not qualified**.
A Compose seat is a container, started by Compose, that holds one generated Pi profile for one user and is reached over SSH. The term is in [the glossary](../../GLOSSARY.md).

This guide is the procedure for the operator. [The Compose seat document](../../deploy/compose/README.md) is the reference: the image, the entrypoint, the Compose files and each variable.

No container of this image has a recorded trial. Use the labels from [the setup guide](setup.md#labels-for-a-prerequisite):

| Label | Meaning here |
| --- | --- |
| `unverified` | The instructions have no accepted trial on this runtime. |
| `blocked` | A required tool, version or service is missing. |
| `skipped` | You did not run the step. |

An offline check that passes is recorded as passed, not as a qualification of a runtime.

## Words in this guide

- **Kit**: the clone of this repository. The examples use `"$HOME/tenant-pi"`.
- **Private directory**: a directory outside the kit that only the operator reads. The examples use `"$HOME/.config/tenant-pi"`. See [the private directory](../private-directory.md).
- **Operator**: the person who builds and starts the seat. **User**: the person who logs in. They can be the same person.
- **Seat account**: the one account of the container that accepts an SSH login. The default name is `pi`.
- **Provider**: this word has two meanings under Podman. A *Compose provider* is the program that `podman compose` runs. A *machine provider* is the virtual machine type of `podman machine`. This guide always writes the full term.

`<private dir>`, `<gateway url>`, `<port>`, `<account>`, `<uid>`, `<gid>`, `<commit>`, `<pin>` and `<file>` are placeholders. Replace each one with your value.

## Before you start

The machine that runs the seat needs Git, Python 3.11 or later, the kit clone and one container runtime. It does not need Node or Pi: the image holds them.

The image build runs on the machine that runs the seat. The Dockerfile names no target architecture, so the image has the architecture of that machine.

### Docker Compose on Linux

The seat needs Docker with Compose v2, the `docker compose` plugin.

```sh
docker version
docker compose version
```

Both commands must print a version. `docker compose version` must print a version 2 or later.
Not verified: the lowest Compose version that reads the two Compose files. `ComposeConfigTests` in `tests/test_compose_seat.py` runs `docker compose config` on both Compose files when `docker compose` is present.

### Podman on macOS on Apple silicon

macOS uses zsh as its login shell. Put each `PATH` or variable line in `~/.zshrc`, and reload it with `exec zsh`.

Podman runs Linux containers in a virtual machine on macOS. [The macOS guide](macos.md#scanner-recommended-podman-container-path) has the install lines of Podman.

1. Start the Podman machine.

   ```sh
   podman machine list
   podman machine start
   podman info
   ```

   `podman info` must print the machine data without an error. Run `podman machine init` first when the list is empty.

2. Find the machine provider.

   ```sh
   podman machine info
   ```

   The output names the machine provider. Podman on Apple silicon has two machine providers: `libkrun` and `applehv`. Record the name: the qualification table has one row for each.

3. Install one Compose provider.

   `podman compose` is a wrapper. It runs one of two Compose providers: `docker-compose` or `podman-compose`. Podman installs neither of them.

   ```sh
   podman compose version
   ```

   The command must print the version of the Compose provider that it runs. An error shows that no Compose provider is on the `PATH`.

4. Record which Compose provider ran.

   The two Compose providers treat the gateway key in different ways. See [the gateway key](#the-gateway-key).

Not verified: each step of this section with the kit. Not verified: the install of a Compose provider with Homebrew.

Under Podman, `<private dir>/seat.env` needs one more value than under Docker:

```text
SEAT_USERNS=keep-id:uid=<uid>,gid=<gid>
```

`<uid>` and `<gid>` are the values of `SEAT_UID` and `SEAT_GID` in the same file. The `compose-plan` action writes a comment line with the exact value above the `SEAT_USERNS=` line. Under Docker, the value stays empty.

### Windows and WSL 2

Windows and WSL 2 are not qualified, and this guide has no steps for them.

## Step 1: make the files of the private directory

The seat reads five files from the private directory: `overlay.json`, `seat.env`, `compose.env`, `authorized_keys` and `registry.json`.

The guided path makes them. An agent follows Stage 4c of [the install document](../../INSTALL.md#stage-4c-the-compose-seat): it asks eight questions, shows the plan of the `compose-plan` action, and writes the five files on your yes. [The CLI contract](../generator.md#compose-plan-the-files-and-the-commands-of-a-compose-seat) has each option and each refusal of the action.

The guided path and the `compose-plan` action support the gateway route only, through the component `codex-accounts` ([modules guide](modules.md)). For a provider with a native login, write the private directory files by hand. Use the two env templates and the notes on the private directory in [the seat README](../../deploy/compose/README.md). Use the overlay rules of [INSTALL.md, Stage 5](../../INSTALL.md#stage-5-the-private-overlay). The `overlay` and `registry` keys of the plan in Stage 4c, part 2, show the shape of these two files. The seat README permits an empty gateway key for a native login. Not verified: a native login in the seat.

By hand, the gateway path is the same action:

1. Print the plan. The command writes nothing and runs nothing.

   ```sh
   cd "$HOME/tenant-pi"
   python3 scripts/tenant_pi.py compose-plan --uid "$(id -u)" --gid "$(id -g)" --public-key "$HOME/.ssh/id_ed25519.pub" \
     --gateway-url '<gateway url>' --private-dir "$HOME/.config/tenant-pi" --model codex-auto/astra
   ```

   The output is one JSON object. Read `overlay`, `seatEnv`, `composeEnv`, `commands` and each entry of `warnings`.

2. Create the private directory when it is absent.

   ```sh
   mkdir -p "$HOME/.config/tenant-pi" && chmod 700 "$HOME/.config/tenant-pi"
   ```

   `ls -ld "$HOME/.config/tenant-pi"` must show the mode `drwx------`.

3. Run the same command with `--write` as the last option.

   The action creates the five files with mode 600. It refuses when one of them exists, and then it writes none. [Troubleshooting](troubleshooting.md#the-compose-seat) has each refusal and its fix.

4. Put the key value into `compose.env`.

   Open `<private dir>/compose.env` in your editor. Put the gateway key between the two single quotes of the `TENANTEXT_LITELLM_API_KEY=''` line. `ls -l "<private dir>/compose.env"` must still show the mode `-rw-------`.

5. Under Podman only: set `SEAT_USERNS` in `<private dir>/seat.env`.

   Use the value of the comment line above it.

Rules for the answers:

- **The gateway URL.** The overlay validator accepts only an HTTPS URL on port 443 that ends in `/v1`, without a credential. The seat cannot use a gateway over HTTP or on another port. See [the gateway route](#the-gateway-route).
- **The model.** `--model` and `--thinking` are the model and the thinking level of `roles.interactive`. The action writes them into `overlay.json` and into `registry.json`. Under the provider `litellm-codex` the model is `codex-auto/astra`, `codex-auto/sol` or `codex-auto/luna`.
- **The projects directory.** `--projects-dir` names a directory that the action does not check. Create the directory as the operator before the start. Not verified: a missing directory under Docker may be created with root as owner, and Podman may refuse the start.
- **The components.** Keep `mcp` and the memory modules out of the first seat. Each one needs hand edits of `overlay.json` and more input files in the private directory. See [workflow modules](../workflow-modules.md) and [memory modules](../memory-modules.md).

To change the model or another choice later, edit `<private dir>/overlay.json` by hand. Each model of the overlay also needs its entry in `<private dir>/registry.json`. Then check the edit on the machine of the operator:

```sh
cd "$HOME/tenant-pi"
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json" --registry "$HOME/.config/tenant-pi/registry.json"
```

The command must print a JSON object with `"valid":true`. The entrypoint never writes into a profile that exists, so an edit after the first start does not reach the seat at the next `up -d`. It reaches the seat after a rebuild of the image, as a candidate, or in a new seat after `down -v`. See [Updates](#updates) and [Removal](#removal).

## Step 2: build and start

Run each command from the kit root. Each Compose command needs `KIT_COMMIT` and the env file option with `seat.env`, also `ps`, `logs` and `down`.

`KIT_COMMIT` is in no file, because it changes with the checkout. It is a build argument and the tag of the image, `tenant-pi-seat:<commit>`.

Never give `compose.env` to the env file option. That option reads `seat.env` only.

### Docker

1. Set the commit of the checkout.

   ```sh
   cd "$HOME/tenant-pi"
   export KIT_COMMIT="$(git rev-parse --short HEAD)"
   ```

   `echo "$KIT_COMMIT"` must print a short commit ID.

2. Build the image.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml build
   ```

   The build runs the four offline checks of the kit and installs the pinned Pi. A failed check stops the build.

3. Start the seat.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml up -d
   ```

   `docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml ps` must show the service `seat` as running.

4. Read the log of the first start.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml logs seat
   ```

   The entrypoint prints one line for each step, each with the prefix `seat:`. At the first start it runs `check-runtime`, `validate`, `plan` and `generate`, then it starts sshd. A failure of one of these steps stops the container.

The container has `restart: "no"`. A container that stops stays stopped. Read its log, correct the cause, then run `up -d` again.

### Podman

The commands are the same with `podman compose`:

```sh
cd "$HOME/tenant-pi"
export KIT_COMMIT="$(git rev-parse --short HEAD)"
podman compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml build
podman compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml up -d
podman compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml logs seat
```

Run the checks of the Docker steps after each line. On macOS, the `export` line changes this zsh only.

### With a projects directory

A Compose file has no conditional volume. Thus the projects directory is in a second Compose file. Set `SEAT_PROJECTS_DIR` in `seat.env`, create the directory, and give the two files in each command:

```sh
docker compose --env-file "<private dir>/seat.env" \
  -f deploy/compose/compose.yaml -f deploy/compose/compose.projects.yaml up -d
```

The second `-f` is in each command of the seat from then on, also `ps`, `logs` and `down`. The seat gets the directory at `/projects`, with read and write access.

Warning: `SEAT_BIND=0.0.0.0` in `seat.env` opens the seat to the network. The default, `127.0.0.1`, accepts connections from this machine only.

## Step 3: log in

1. Connect with the key of `authorized_keys`.

   ```sh
   ssh -p <port> <account>@127.0.0.1
   ```

   The first login asks you to accept the host key of the seat. The defaults are port `2222` and account `pi`.

2. Check the session.

   An interactive login opens the tmux session `seat`, or attaches to it. The working directory is `/projects` when the projects directory is there, else the home directory. When tmux ends without an error, the login ends.

3. Check that the key variable is set, without its value.

   ```sh
   [ -n "${TENANTEXT_LITELLM_API_KEY:-}" ] && echo "key set"
   ```

   The command must print `key set`. A seat without a key prints nothing: that is correct only for a provider with a native login.

4. Start Pi.

   ```sh
   pi-profile
   ```

   `pi-profile` is the launcher of the profile. It holds the gateway URL from the overlay and no key.

5. Optional: use Herdr.

   Run `herdr` in the tmux session. Then run `pi-profile` in a Herdr pane. The image holds Herdr 0.9.3 and no Herdr defaults file.

### When the terminal type is unknown

The image has the terminal descriptions of `ncurses-base` only. A terminal such as Ghostty or kitty sends a `TERM` value that the image does not know. The login then prints one line with the original value and continues with `TERM=xterm-256color`.

When tmux fails, the login prints `seat: tmux failed; this shell has no tmux session`, and the login shell stays. A login shell can read the profile more than once, so the line can appear more than once.

When a login does not give a shell that you can use, start a shell without tmux:

```sh
ssh -t -p <port> <account>@127.0.0.1 'TERM=xterm-256color TMUX=none bash'
```

`bash` is the shell of the seat account inside the container, not a shell of your machine. It is an interactive shell with a terminal, so it reads `.bashrc` and the profile. The profile starts tmux only when `TMUX` is empty. `TMUX=none` is not empty, so this shell starts no tmux. It has `TERM=xterm-256color`, the `PATH` and the key variable.

A login with a command that is not a shell, for example `ssh -p <port> <account>@127.0.0.1 pi-profile --version`, starts no tmux: its shell is not interactive. It gets the `PATH` and the key variable.

Not verified: the tmux session, the `TERM` fallback, the two failure lines and this command in a container.

## The gateway route

The model route of the seat is one gateway with one key. The overlay holds the URL, and `compose.env` holds the key. See [Step 1](#step-1-make-the-files-of-the-private-directory) for the route limit of the guided path and the `compose-plan` action.

### The gateway URL

- The URL is HTTPS on port 443 and ends in `/v1`. The validator refuses each other form.
- The gateway must be reachable from inside the container. `localhost` inside the container is the container, not your machine.
- The default is a gateway on the local network, with a name that the container can resolve. Use this route for a first seat and for a trial.

A gateway on the machine that runs the seat is a special case. It is usable only when it serves HTTPS on port 443 with a certificate that is valid for the name in the URL.

| Runtime | Name of the machine from inside the container | What you add |
| --- | --- | --- |
| Docker on Linux | `host.docker.internal` | A second Compose file that you write. See below. |
| Podman machine on macOS | `host.containers.internal` | Nothing. Not verified: the name resolves in the seat. |

Under Docker on Linux, write this file as `<private dir>/compose.host-gateway.yaml`:

```yaml
services:
  seat:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Then give it as one more `-f "<private dir>/compose.host-gateway.yaml"` in each Compose command, after `compose.yaml`. The gateway URL of the overlay is then `https://host.docker.internal/v1`, and the certificate of the gateway must be valid for the name `host.docker.internal`.

The override is for Docker on Linux only. Do not use it under Podman machine. The kit does not ship this file, and the base Compose file has no `extra_hosts` key.

Not verified: each form of this section in a container.

### The gateway key

1. The operator puts the key value into `<private dir>/compose.env`, between single quotes: `TENANTEXT_LITELLM_API_KEY='...'`. Compose interpolates `$` in the file. An unquoted ` #` starts a comment. Single quotes keep the value literal.
2. The container gets the variable through `env_file` of the service.
3. At each start, the entrypoint writes the value to `/run/tenant-pi-seat/gateway-key`. The directory is a tmpfs, so the file is in memory only. The seat account owns it, with mode 0400.
4. Each shell of the seat account exports the variable from that file. sshd gives no variable of the container to a login session.

Warning: `docker compose config`, `docker inspect` and `podman inspect` print the key value of `compose.env`. Do not run them in a shared terminal or in an agent session.

Warning: with the Compose provider `podman-compose`, the key value is also on a `podman` command line during the start. Not verified: how the Compose provider `docker-compose` sends the value to Podman.

The image, the kit clone and the overlay hold no key value. To change the key, edit `compose.env`, then run the `up` line again as `up -d --force-recreate`. Not verified: the key change in a container.

## Updates

A new kit version never changes the profile of the seat. A new image offers a candidate beside it.

Warning: `up -d` alone keeps the old image. The image tag is `KIT_COMMIT`, so an update needs a new `KIT_COMMIT` and a `build`.

1. Get the new checkout.

   ```sh
   cd "$HOME/tenant-pi" && git pull
   export KIT_COMMIT="$(git rev-parse --short HEAD)"
   ```

   `echo "$KIT_COMMIT"` must print another value than before the pull.

2. Build the new image.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml build
   ```

   The build runs the four offline checks of the new checkout.

3. Recreate the container.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml up -d
   ```

   The home volume and the host key stay. Each tmux session of the old container ends.

4. Read the offer.

   ```sh
   docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml logs seat
   ```

   The entrypoint compares the build record of the image with the record of the profile. When they differ, it generates the candidate `~/.pi/profiles/candidate-<commit>-<pin>` and prints five steps. `<pin>` is the Pi version of the image.

5. Follow [the candidate update guide](candidate-update.md#step-3-compare) from Step 3, inside the seat.

   ```sh
   python3 /opt/tenant-pi/scripts/tenant_pi.py compare --left "$HOME/.pi/profiles/main" --right "$HOME/.pi/profiles/candidate-<commit>-<pin>"
   ```

   The log of the seat prints this line with the real paths. Reconcile each difference as the guide says.

6. Switch to the candidate.

   ```sh
   pi-profile-candidate-<commit>-<pin>
   ```

   Each candidate has its own launcher in `~/.local/bin`. `pi-profile` still starts the old profile, which is the fallback.

7. Record the build, to end the offer.

   ```sh
   cp /opt/tenant-pi/.seat-build "$HOME/.tenant-pi/seat-build"
   ```

   The entrypoint repeats the offer at each start until this record is equal to the record of the image. It never switches the profile for you.

With Podman, use `podman compose` in steps 2 to 4. With a projects directory, keep the second `-f`.

A failure of the candidate generation does not stop the container. The profile of the seat stays as it is.

Not verified: a rebuild with a changed Pi pin, and the generation of a candidate, in a container.

## Removal

To stop the seat and keep its data:

```sh
docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml down
```

`down` removes the container. It keeps the two named volumes: `seat-home` with the profile, the sessions and the Herdr state, and `seat-ssh` with the host key. The next `up -d` gives the same seat.

To remove the seat with its data:

```sh
docker compose --env-file "<private dir>/seat.env" -f deploy/compose/compose.yaml down -v
```

Warning: `down -v` deletes the home volume with the profile, the sessions and each file of the home directory. It also deletes the host key, so the next seat has a new host key and each SSH client refuses it until you remove the old key from `known_hosts`.

`down -v` does not remove the image, the private directory or the projects directory. Remove them by hand after you read each path twice.

## Limits

- `scp` and `sftp` fail: `sshd_config` has no `Subsystem sftp` line. Copy a file through the projects directory, or with `ssh -p <port> <account>@127.0.0.1 'cat > <file>' < <file>`.
- One Compose project holds one seat. The project name is `tenant-pi-seat`. A second seat on the same machine is not a supported form.
- The seat account has no sudo. A package install needs a new image.
- `scripts/publish_check.py` fails inside the finished image, because `/opt/tenant-pi/.seat-build` is not in the publish set. The build runs the check before it writes that file.
- `kitCommit` in `.tenant-pi/state.json` of the profile is `unknown`, because the image has no Git metadata. The kit commit of a seat is the build argument `KIT_COMMIT`. `/opt/tenant-pi/.seat-build` holds it.
- A Pi self-update inside the container lives in the container layer. A recreate of the container loses it.
- A profile with `promptr` needs the build of `packages/promptr` in the checkout before the image build.

## Qualification

No runtime is qualified. A row changes only when a trial records evidence for each item of the checklist below, and the maintainer of the release accepts the record.

| Runtime | Machine | Compose provider | Status | Recorded trial |
| --- | --- | --- | --- | --- |
| Docker with Compose v2 | Linux x86_64 | the `docker compose` plugin | not qualified | none |
| Podman, machine provider `libkrun` | macOS on Apple silicon | `docker-compose` or `podman-compose`; the record names it | not qualified | none |
| Podman, machine provider `applehv` | macOS on Apple silicon | `docker-compose` or `podman-compose`; the record names it | not qualified | none |

Windows, WSL 2 and each other runtime have no row and are not qualified.

### What a trial must cover

A record names the runtime version, the Compose provider and its version, the machine provider, the kit commit and the Pi pin. It gives each item as passed, failed, blocked or not run.

For each runtime:

1. The container starts, and the log shows each step of the first start.
2. An SSH login with the key works as the seat account. A login without the key is refused.
3. An interactive login opens the tmux session `seat`.
4. The key variable is set in a login session, and `pi-profile` gets a model reply through the gateway.
5. The home volume keeps the profile across `down` and `up -d`, with the seat account as its owner.
6. The host key is the same after `down` and `up -d`.
7. A rebuild with a changed Pi pin offers the candidate `candidate-<commit>-<pin>`, and the offer ends after the record step.
8. The entrypoint gives `--registry` to its commands when `registry.json` exists, and `--local-dir` when the overlay enables `mcp`.
9. bash reads `.bashrc` for a command login, so a command login has the `PATH` and the key variable.
10. The `TERM` fallback and the login shell after a tmux failure work as this guide says.

For Podman, on each of the two machine providers:

1. `keep-id` works with sshd as root: the entrypoint starts, and the seat account has the UID and the GID of the operator.
2. The seat reads the private directory through the read-only bind.
3. The seat writes to the projects directory through the read-write bind, and the file has the owner of the operator on macOS.
4. `host.containers.internal` resolves inside the seat.
5. With the Compose provider `podman-compose`: the tmpfs option `mode=` holds, or the entrypoint corrects the mode.
6. The Compose provider reads a quoted value of `seat.env`.
7. The image build passes on arm64: it downloads the Herdr asset `herdr-linux-aarch64`, and the SHA-256 check of the asset passes.

A `config` run, an image build and this guide do not change a status.
