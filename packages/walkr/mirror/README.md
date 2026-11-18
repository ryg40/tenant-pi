# History mirror (optional)

The history mirror is a persistent, read-only Walkr history page: the Compare page layout with the sessions of every type (Core, Double, Coinflip, Trainer and Compare).
It shows the session records of one directory, the mirror root. A copy script fills that root from your computers.
You then read each session on one page, also when the local Walkr servers are stopped.

The mirror is optional. `install.sh` of the kit and the Walkr setup do not install it, link it or start it, on Linux or on macOS. It is available in each clone as the directory `packages/walkr/mirror`. You start it by hand, in a service or in a container.

## What it does

- `/` leads to the page. This address stays the same after a restart.
- The page lists each session of the root, newest first. A Compare session shows the options, the result, the rating and the outcome. The other types show read-only, in the format of their type, with the command that opens the session live on its computer.
- Each row names its computer when the root holds more than one. Compare rows have no computer name: all computers share `sessions/`.
- The server accepts GET only. Each write returns `403` with the code `READ_ONLY`. You pick, rate and submit on the Walkr page of the computer that made the session.
- The server writes nothing, so the root can be a read-only mount.
- `/health` answers `{ "ok": true }`.

Warning: the mirror has no login of its own. Each client that reaches the port reads each session. Keep it on `127.0.0.1`, or put it behind a proxy that asks for a login.

## Start it

```sh
HUMAN_REVIEW_COMPARE_ROOT=/srv/walkr-mirror HUMAN_REVIEW_PORT=4810 node packages/walkr/mirror/server.js
```

| Variable | Use | Default |
| --- | --- | --- |
| `HUMAN_REVIEW_COMPARE_ROOT` | The mirror root | `~/.local/.walkr/compare` |
| `HUMAN_REVIEW_PORT` | The port | A free port |
| `HUMAN_REVIEW_BIND` | The listen address | `127.0.0.1` |
| `HUMAN_REVIEW_ALLOWED_HOSTS` | Extra exact `name:port` values of the Host header, separated by commas | None |

The server refuses a Host header that is not loopback and not in `HUMAN_REVIEW_ALLOWED_HOSTS`. A proxy sends the public name, or sets the Host to `127.0.0.1:<port>`.

With the default root, the mirror shows the sessions of this computer and changes nothing in them.

For a container, build from the package directory:

```sh
cd packages/walkr
docker build -f mirror/Dockerfile -t walkr-mirror .
docker run --read-only -v /srv/walkr-mirror:/mirror:ro -p 127.0.0.1:4810:3000 \
  -e HUMAN_REVIEW_ALLOWED_HOSTS=127.0.0.1:4810,localhost:4810 walkr-mirror
```

Open `http://127.0.0.1:4810/`. The server accepts a Host header that is a loopback name with the port inside the container (`3000`), or a value in `HUMAN_REVIEW_ALLOWED_HOSTS`, so the published port `4810` must be in that list.

Warning: do not publish the port without `127.0.0.1:`, because the page has no login.

The user of the server must own the root. The image runs as the user `node` (1000).

## The root

```text
<root>/sessions/<session-id>/session.json        Compare, all computers
<root>/hosts/<host>/core/state.json             Core state file of one computer
<root>/hosts/<host>/double/                     Double and Coinflip records of one computer
<root>/hosts/<host>/trainer/<repo>/dataset/     Trainer datasets of one computer
```

`<host>` is a name of letters, digits, `.`, `_` and `-`. The page shows it on each row.
A root with only `sessions/` (from the old copy script) still works: it shows Compare only.

## Fill the root

`sync.sh` copies the records one way with `rsync`. It deletes nothing. A changed record, for example after a rating, replaces its copy.

```sh
packages/walkr/mirror/sync.sh /srv/walkr-mirror server=/home/me desk=desk.example:
```

- The first argument is the mirror root. Each other argument is `NAME=HOME`: the name of the computer and its home directory, as a local path or in the `host:` form of `rsync` (`desk.example:` is the remote home).
- From each home the script copies `.local/.walkr/compare/sessions`, `.human-review/state.json`, `.local/.walkr/double` and `.local/.walkr/trainer`. These are the default places. A computer that sets `HUMAN_REVIEW_STATE_DIR`, `HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR`, `HUMAN_REVIEW_TRAINER_ROOT` or `HUMAN_REVIEW_COMPARE_ROOT` to other places needs links or another copy step.
- The script never copies `server.json`, `server.lock`, a token, `pristine/`, the shared GUI record (it names the Pi chat), temporary files or review copies.
- A part that does not exist yet on a computer (`rsync` exit 23 or 24), the Compare sessions included, prints a note and is no failure. In the old form a Compare root that is gone makes the exit code 1.
- The old form `sync.sh DEST_ROOT SOURCE_COMPARE_ROOT...` still works and copies Compare only. An argument without `=` is a Compare root.
- A session ID holds its time and a random part, so the sessions of two computers do not collide in one root.
- The script sets the modes that the store demands: `0700` for directories and `0600` for records.
- `WALKR_MIRROR_OWNER=1000:1000` sets the owner of the copies. Only root can use it. Use it when root copies for a container user.
- A source that does not answer makes the exit code 1. The copies of the other sources and the earlier copies stay.
- Runs on `rsync` 2.6.9, openrsync (macOS) and `rsync` 3.

Run the script from a timer, for example each minute.

## Limits

- The mirror loads no Double or Coinflip candidate page. The candidates show in the shared GUI of the computer that made them.
- A session appears after the next run of the copy script.
- The mirror is not verified on macOS.
