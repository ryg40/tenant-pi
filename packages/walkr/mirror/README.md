# Compare mirror (optional)

The Compare mirror is a persistent, read-only Compare page. It shows the session records of one directory, the mirror root.
A copy script fills that root from the Compare roots of your computers. You then read each result on one page, also when the local Walkr servers are stopped.

The mirror is optional. `install.sh` of the kit and the Walkr setup do not install it, link it or start it, on Linux or on macOS. It is available in each clone as the directory `packages/walkr/mirror`. You start it by hand, in a service or in a container.

## What it does

- `/` leads to the page. This address stays the same after a restart.
- The page lists each session of the root, newest first, with the options, the result, the rating and the outcome.
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

## Fill the root

`sync.sh` copies the records one way with `rsync`. It deletes nothing. A changed record, for example after a rating, replaces its copy.

```sh
packages/walkr/mirror/sync.sh /srv/walkr-mirror ~/.local/.walkr/compare desk.example:.local/.walkr/compare
```

- The first argument is the mirror root. Each other argument is a Compare root, as a local path or in the `host:path` form of `rsync`.
- A session ID holds its time and a random part, so the sessions of two computers do not collide in one root.
- The script sets the modes that the store demands: `0700` for directories and `0600` for records.
- `WALKR_MIRROR_OWNER=1000:1000` sets the owner of the copies. Only root can use it. Use it when root copies for a container user.
- A source that does not answer makes the exit code 1. The copies of the other sources and the earlier copies stay.

Run the script from a timer, for example each minute.

## Limits

- The mirror shows Compare sessions only. It shows no Core, Double, Coinflip or Trainer session.
- A session appears after the next run of the copy script.
- The mirror is not verified on macOS.
