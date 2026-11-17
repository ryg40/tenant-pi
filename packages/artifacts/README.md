# artifacts

The optional kit module `artifacts`: a skill and a CLI that store an HTML or Markdown file on the artifact server of the user and print the view link.

| Path | What |
|---|---|
| `skills/artifacts/SKILL.md` | The skill: when to upload, the commands, the rule for the view link. |
| `skills/artifacts/scripts/artifacts` | The CLI (Python 3, standard library only): `setup`, `upload`, `list`, `open`, `doctor`, and `start`, `off` (`stop`) and `status` for one local server. |
| `prompts/artifacts.md` | The Pi prompt `/artifacts start`, `/artifacts off` and `/artifacts status`. |

The package is separate from `packages/tenantext`, because Pi loads every skill of a package entry. `install.sh --with artifacts` adds this package to the profile, links the CLI to `~/.local/bin/artifacts` and runs `artifacts setup`. See the module guide `docs/guides/modules.md` of the kit.

## Configuration

`artifacts setup` writes `~/.config/tenant-artifacts/config.json` (in `$XDG_CONFIG_HOME/tenant-artifacts/` when `XDG_CONFIG_HOME` is set) with mode 0600. The file holds `origin` and `tokenFile`, and for a local server `clone` and `port` (`setup --clone PATH --port N`); `setup` keeps each other key. The token itself stays in the token file, one token in the file, and the CLI reads it inside its process.

An origin is `https://<host>[:port]`, or `http://` only for a loopback address, for example `http://127.0.0.1:8080`. Example: `artifacts setup --origin https://artifacts.example.com --token-file ~/.config/tenant-artifacts/token --yes`. With `--yes`, `setup` refuses to replace a saved origin that differs; add `--replace-origin` to replace it.

## The secret scan

Before each upload, the CLI runs `scripts/scan.sh --level warn tree` of the kit on a copy of the file in a scratch Git repository, when the CLI runs from a kit tree. A secret or policy finding, or a scanner that does not run (for example, no Betterleaks binary), stops the upload with exit 5. Outside a kit tree, the CLI prints one warning line and uploads.

### Test seam

For tests only, not a setting: the environment variable `ARTIFACTS_SCAN_COMMAND` replaces the kit scanner with another command line (shell words, parsed with `shlex`). The command runs in the scratch repository; exit 0 is a clean scan, exit 1 is a finding, and another exit is a scanner that could not run. When the variable is set, the CLI prints one warning line, because the kit scanner does not run.

## Requests

The CLI sends requests only to the configured origin: `POST /v1/artifacts` and `GET /v1/artifacts` with `Authorization: Bearer <token>`, and `GET /healthz` without the token. It follows no redirect and ignores the proxy variables. With no configuration, each command except `setup` exits 4 before any request. The edit token of an upload answer is neither printed nor kept.

`artifacts open` prints the URL. When `HERDR_ENV=1` and a Sheprd command is found, it also runs `sheprd browser open <url>`. It looks for the Sheprd command in this order: `sheprd` on `PATH`, `~/.local/bin/sheprd`, and the old path `~/.local/state/herdr/gpui/bin/herdr-gpui` of an old install. It starts no other browser.

## Local server

`artifacts start` runs the server of the configured clone with Node on `127.0.0.1`, in its localhost mode, and prints the browse URL as its last line. `artifacts off` stops each local server of this user that runs that clone; on Linux only a process in the PID namespace of the CLI matches. A process matches only when the base name of its `argv[0]` is exactly `node` and its first argument without a leading `-` (the script) has the real path of `server.mjs` of the clone. On Linux the CLI resolves a relative script against the working directory of the process. Limit on macOS: `ps` gives no working directory, so the script must be an absolute path; a server started by a relative path, for example `cd <clone> && node server.mjs`, is not matched there. `artifacts --json status` prints `{"state": ..., "url": ...}`. The module guide `docs/guides/modules.md` of the kit gives the rules, the files and the tunnel steps.
