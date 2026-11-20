# artifacts

The optional kit module `artifacts`: a CLI that stores an HTML or Markdown file in a local artifact store, and a small web server on `127.0.0.1`. The server has a root page `/`, the page `/artifacts` with the stored pages, and the Walkr page `/walkr`. The routes of the artifacts only read the store. The Walkr pass sends three page writes to the live Walkr server. The artifacts part is Python 3, standard library only: no Node, no npm step, no database and no token. The Walkr pass needs Walkr, which runs on Node.

| Path | What |
|---|---|
| `skills/artifacts/SKILL.md` | The skill: when to upload, the commands, the rule for the view link. |
| `skills/artifacts/scripts/artifacts` | The CLI: `setup`, `upload`, `list`, `open`, `delete`, `retention`, `doctor`, and `start`, `off` (`stop`) and `status` for the server. |
| `skills/artifacts-server/SKILL.md` | The Claude Code command `/artifacts-server start \| off \| status`. |
| `prompts/artifacts-server.md` | The same command as a Pi prompt. |
| `server/artifacts_store.py` | The store and the configuration, shared by the CLI and the server. |
| `server/artifacts_server.py` | The server: one route table and one map from content type to view. |
| `server/web/` | The style and the scripts of the index page, the viewer page and the Markdown view, and the vendored `marked` and `highlight.js` (see `THIRD_PARTY_NOTICES.md`). |

The package is separate from `packages/tenantext`, because Pi loads every skill of a package entry. The CLI finds the server from its own real path, so a link to the CLI (for example `~/.local/bin/artifacts`) works. See the module guide `docs/guides/modules.md` of the kit.

## The store

`artifacts upload FILE` writes the file into `~/.local/share/tenant-artifacts/store/` (`$XDG_DATA_HOME/tenant-artifacts/store/` when that variable holds an absolute path), mode 0700. Each artifact is one directory `<store>/<slug>/` with the uploaded bytes in `source` and the facts in `meta.json`: `slug`, `title`, `fileName`, `contentType`, `repo`, `createdAt`, `byteSize`, and `updatedAt` and `revision` after a replace. The slug is 32 random URL-safe characters, and it does not start with `-`. A slug of an older upload can start with `-`: give it as `--replace=SLUG`, or after `--`, for example `artifacts delete -- SLUG`. The CLI builds the directory under a scratch name in the store, then renames it to the slug, so the server never shows a half-written artifact. An upload needs no running server. `upload` prints the viewer link `/v/<slug>`.

`artifacts upload FILE --replace SLUG` stores the new file under an existing slug, so the link stays. It keeps `slug` and `createdAt`, sets `updatedAt`, adds 1 to `revision` (an artifact without the key counts as 0), and takes the file name, the content type and the size from the new file. The title and the repo stay unless `--title` or `--repo` gives a new one. An unknown slug, a wrong extension or a scan finding changes nothing. The CLI first writes both new files beside the old ones. When that fails, it removes them, and the artifact does not change. Then it moves them over the old files with `os.replace`: first `source`, then `meta.json`. A reader always gets a whole file. Between the two moves, a reader gets the new bytes with the old facts, for example the old title and the old content type. When the second move itself fails, the artifact keeps that state, and the CLI says `cannot replace` and exits 2. A new `--replace` of the same slug repairs it.

`artifacts delete SLUG [SLUG ...]` deletes the named artifacts and prints one `deleted:` line for each. It deletes only a directory directly inside the store, not a symlink, whose name is a slug and whose `meta.json` can be read and names that slug. It checks each slug first: when one is not such an artifact, it deletes nothing and exits 2. For each artifact, it renames the directory to a scratch name in the store that starts with `.`, so the artifact leaves the list in one step, and then removes that directory. When the removal fails, the scratch directory stays: the command names its path and exits 2.

The repo of an upload is the `--repo` value. Without it, the CLI takes the name of the repository of the `origin` remote of the working directory (the last part of its URL, without `.git`), else the directory name of the main checkout, else no repo. It stores only the name, never the remote URL.

The old directory `~/.local/share/tenant-artifacts/data` of an earlier server design stays as it is.

## The server

`artifacts start` starts the server detached on `127.0.0.1:<port>` (default 6790). It prints the line `root: <URL of />` and, when Walkr is installed, the line `walkr: <URL of /walkr>`. Its last line is the URL of `/artifacts`. A second `start` starts nothing and prints the same lines. `start` writes the state file `~/.local/state/tenant-artifacts/server.json` right after the server process starts, and removes it when the start fails. `artifacts off` signals a PID only when `/healthz` on the configured port answers with the service `tenant-artifacts`, the user ID of the CLI and the same PID as the state file. `off` never signals a Walkr process. When a live Walkr server answers, `off` prints one line that says that the Walkr server still runs and that `off` does not stop it. Walkr counts as installed when the program `walkr-compare` is on the `PATH`. The server log is `server.log` in the same directory.

`artifacts status` prints the state, the health, the URL of `/artifacts`, the line `root:` and, with Walkr, the line `walkr:` with the word `open` or `closed`. `artifacts --json status` prints one object, for example:

```json
{"state": "running", "url": "http://127.0.0.1:6790/artifacts", "schema": 2, "pid": 12345, "port": 6790,
 "host": "127.0.0.1", "modules": ["artifacts", "walkr"],
 "pages": {"root": "http://127.0.0.1:6790/", "artifacts": "http://127.0.0.1:6790/artifacts", "walkr": "http://127.0.0.1:6790/walkr"},
 "walkr": {"socket": "open"}, "store_host": "HOST"}
```

- `state` is `running` or `stopped`, and no other word. `state` and `url` are always present.
- `url` is the URL of `/artifacts`. A server from before this version has no `/artifacts`, and its `/healthz` answer has no `schema` key. For that server, `url` and `pages.artifacts` are the root URL, and the text form says that `artifacts off` and `artifacts start` give the new pages.
- `pid` is present only when the server runs. `store_host` is present only when the key `remote` is set.
- `modules`, `pages.walkr` and `walkr` come from the `/healthz` answer when the server runs. When it is stopped, the CLI finds them with the same rule as the server. Without Walkr, `pages.walkr` and `walkr` are absent.
- The CLI builds each URL of `pages` from the configured port. No value of the Walkr record (no token, no port of the live Walkr server) is in the output.

`artifacts doctor` prints one line for Walkr: installed or not, and the live server open or closed. That line does not change the result `PASS` or `FAIL`.

The CLI counts a server only when its `/healthz` answer has the user ID of the CLI. A server of another user on the port is another program: `status` says `stopped`, `start` refuses the port and names `artifacts setup --port N`, and `upload` prints that no server runs.

The artifact server of an earlier kit version (`node server.mjs`) used the same default port, and `artifacts off` does not stop it, because `off` signals only its own server. When the program on the port answers `/healthz` with `{"status": "ok"}` and no `service` key, `start` and `doctor` say that it is probably that server. They name the command that finds its process, `ss -ltnp 'sport = :N'` on Linux or `lsof -nP -iTCP:N -sTCP:LISTEN` on macOS; end that process with `kill`.

The server answers `GET` and `HEAD` only, except the requests of the Walkr Compare page that it passes to the live Walkr server (see [The Walkr pass](#the-walkr-pass)). It admits a request only from a loopback peer with the host name `127.0.0.1`, `localhost` or `[::1]` in the `Host` header, with any port; else it answers 403. This stops DNS rebinding, and a port forward can use another local port.

| Path | Answer |
|---|---|
| `/` | The root page: a link to `/artifacts` and a link to `/walkr`. |
| `/artifacts` | The index page: a table of the artifacts with a live thumbnail, sortable columns, a filter and the retention setting. The switch `Table` / `Gallery` shows the same artifacts as a grid of cards with a larger thumbnail, the title, the type, the repo and the created time; a click on a card opens the viewer, and a `Sort` list sets the sort. A narrow window gives one column. A click on a repo name sets the filter `repo:<name>`. A `repo:` word matches only the repo of that name, also typed by hand; for a name with spaces, write `repo:"<name>"`. Each other word matches a part of the title, the file name, the repo or the type. The view, the sort and the filter are in the URL fragment, so a reload and a bookmark keep them; with no fragment, the page shows the table. The page asks `/api/state` every 3 seconds while it is visible, and takes the new rows when the value changes. A thumbnail frame asks `/a/<slug>?thumb`. `/browse` redirects to `/artifacts`. |
| `/v/<slug>` | The viewer page. A bar shows a link to the index, the title, the file name, the type, the repo and the times, and the links `Newer`, `Older` and `Open alone`. Below the bar, a frame shows the artifact with the sandbox tokens of `/a/<slug>`. When the artifact has a new version, the bar shows a note with a `Reload` button; the frame does not load again by itself. When the artifact is gone, the bar says so. |
| `/a/<slug>` | The artifact. An HTML artifact goes out as stored. A Markdown artifact goes out as a page that holds the source as text and renders it in the browser with `marked`. A fenced code block with a language name gets syntax colors from `highlight.js`, which the page loads only when it has such a block. A language that `highlight.js` does not know stays plain text; the page does not guess a language. With the query `?thumb`, the page loads no library past `marked`. |
| `/api/state` | `{"state": <text>, "count": <number>}`. The state is a hash of the slugs, their created times, their versions and the retention setting. The version is the time of the last change, then ` r<revision>` when `revision` is above 0, so two changes in one second give two versions. `/api/state/<slug>` adds `"artifact": {"version": <text>}`, or `"artifact": null` when the artifact is gone. The answer can be up to 2 seconds old: the server keeps its last read of the store for 2 seconds, so many open pages cost one read. |
| `/walkr` | A page that says whether Walkr is installed and whether the live Walkr server answers now. It holds no value of the Walkr record. |
| `/healthz` | `{"status": "ok", "service": "tenant-artifacts", "pid": <pid>, "uid": <user ID>, "schema": 2, "port": <port>, "modules": [...], "pages": {...}}`. `pages` holds paths: `root`, `artifacts` and, with Walkr, `walkr`. With Walkr, `modules` has `walkr` and the key `walkr` is `{"socket": "open"}` or `{"socket": "closed"}`. |
| `/d/<slug>` | The download of an artifact: the stored file, unchanged, with `Content-Disposition: attachment` and the empty sandbox policy. The file name is the last path part of the original name with control characters removed and a quote as `_`; a name that is hidden, ends with a dot, or is longer than 200 bytes becomes the slug with the extension of the content type; a name that is not ASCII also goes into `filename*`. |
| `/_walkr/compare/...`, `/theme.css`, `/theme.js` | The Walkr Compare page, passed to the live Walkr server (see [The Walkr pass](#the-walkr-pass)). |
| `/static/<file>` | The style and script files of `server/web/`. Each answer has `Cache-Control: no-cache` and an `ETag` of the content: the browser asks each time, so a new kit version shows at once, and a matching `If-None-Match` gets 304 with no body. Chrome does not cache the files that a sandboxed artifact page loads, so these files come in full each time. |

Each `/a/<slug>` answer has the policy `sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; frame-ancestors http://<host>`, where `<host>` is the admitted `Host` value of the request. So only a page of this server can frame an artifact. The policy does not use `'self'`, because the web view of Sheprd then refuses the frame. A `[::1]` host keeps `'self'`, because a host source of the policy cannot hold an IPv6 address. With no `allow-same-origin`, a stored page gets an opaque origin and cannot act as the server origin. The index and the viewer are pages of the server origin. Their policy allows only the scripts, the styles, the frames and the requests of the server origin, and no inline script or style. Each value of `meta.json` goes into them escaped.

## Retention

`artifacts retention` prints the setting. `artifacts retention <days>` (1 to 3650) sets the key `retentionDays`; `artifacts retention none` removes it. With no setting, the server deletes nothing. The server sweeps at its start and then once an hour, and it reads the setting at each sweep. A sweep deletes only a directory of the store whose name is a slug, whose `meta.json` can be read, and whose last change is older than the limit. Before it deletes an artifact, it takes the lock of `--replace` and reads `meta.json` again, so an artifact that a replace just renewed stays. It deletes as `delete` does; the server log names a scratch directory that stays. The last change is `updatedAt` when it exists, else `createdAt`. The `expires:` line of `upload` and `artifacts list` use the same rule.

## Configuration

`artifacts setup [--port N] [--remote HOST | --local]` writes `~/.config/tenant-artifacts/config.json` (in `$XDG_CONFIG_HOME/tenant-artifacts/` when that variable holds an absolute path) with mode 0600, and keeps each other key. Each command works with no configuration file. The keys `origin`, `tokenFile` and `clone` of an earlier design stay in the file; the CLI ignores them, and `artifacts doctor` names them.

## A remote store over SSH

Use a remote store when the agents run on one computer and you view the pages on another, for example in Sheprd on your desktop computer, which you reach over SSH. On the computer of the agents, run `artifacts setup --remote HOST`. HOST is an SSH destination: a host alias of your SSH configuration, a host name, or `user@host`, of letters, digits, `.`, `_` and `-`. `artifacts setup --local` removes the key `remote`. The global option `--here`, for example `artifacts --here list`, uses the store of this computer for one call.

With the key, `upload`, `list`, `delete` and `open` run `artifacts --here <command>` on HOST with one `ssh` call each, and give its output and exit code. `ssh` runs with `BatchMode=yes`, so it asks for no password: HOST needs a key login that works without a prompt. HOST needs the `artifacts` command on its `PATH` or in `~/.local/bin`. The other commands work on this computer. `doctor` also prints `remote: HOST` and checks that `artifacts` on HOST answers.

`upload` scans the file on this computer first. Only after that scan do the bytes, the file name, the title and the repo name go to HOST, on the standard input of `artifacts --here upload - --name FILENAME`, with the size and the SHA-256 of the file. A CLI outside a kit tree has no scanner: it warns and sends the file without a scan, as it stores a local upload. HOST refuses a stream that does not match the size and the hash, so a connection that ends in the middle stores nothing. HOST scans the file again and stores it; this computer stores nothing. The output has one more line, `on: HOST`. The `view:` link and the address of `open` are valid on HOST, not on this computer. `open` starts no browser for a remote store. `list`, `delete` and `open` send only the command and the slugs.

`artifacts upload - --name FILENAME` reads the file from standard input. Only the last path part of the name counts.

When `ssh` gets or keeps no connection (exit 255), when HOST has no `artifacts` command, or when HOST gives no answer in time, the command exits 3. The message names HOST, says that the file is not stored, and names `artifacts setup --local` and `artifacts --here`. One case is open: a connection that ends after HOST finished the command. The message names it, and `artifacts list` shows the store of HOST.

## The secret scan

When the CLI runs from a kit tree, it runs `scripts/scan.sh --level warn tree` of the kit before each upload. The scanner gets a copy of the file in a scratch Git repository. The copy holds the bytes that the CLI read, the same bytes that go into the store. A secret or policy finding, or a scanner that does not run (for example, no Betterleaks binary), stops the upload with exit 5, and the store gets nothing. Outside a kit tree, the CLI prints one warning line and stores the file.

### Test seams

For tests only, not settings. Each variable holds a command line (shell words, parsed with `shlex`), and the CLI prints one warning line when it is set.

- `ARTIFACTS_SCAN_COMMAND` replaces the kit scanner. The command runs in the scratch repository; exit 0 is a clean scan, exit 1 is a finding, and another exit is a scanner that could not run.
- `ARTIFACTS_SSH_COMMAND` replaces the program `ssh` of the remote store. It gets the same arguments as `ssh`: the options, `--`, the host and the remote command line.

## The Walkr pass

The server passes the requests of the Walkr Compare page to the live Walkr server, so the page works on the port of this server and through a port forward. The pass covers Compare sessions only. Core, Double, Trainer and Coinflip stay on the port of the live Walkr server.

- The pass sends a request only when its method and its path are in one exact list (`PASSED` in `server/walkr_front.py`). `GET`: the page, its frames, its scripts and styles, `/theme.css`, `/theme.js`, the history and the view of one session. `POST`: only `seen`, `submit` and `rate` of one session. Each other request stays here: a `POST` gets 405, another path 404, and a `HEAD` gets the answer of this server. A path with a query is never passed.
- The pass sends the method, the path, the `Host` header, the `Origin` header, the content type, the page token header and the body unchanged; a body can have up to 8 MiB. It gives back the status, the content type, the policy headers and the body. The page token and the checks of the live Walkr server decide each request.
- A request with an `Origin` header that is not an HTTP origin with a loopback name (`127.0.0.1`, `localhost` or `[::1]`, any port) gets 403.
- The pass reads only the port and the PID of the Walkr record and never sends its agent token. With no live Walkr server, a passed path gets 503 with a JSON reason that names `artifacts walkr-url`. One deadline of 10 seconds covers the check that the live Walkr server answers and the exchange with it. It does not cover the upload of the body from the client.
- The path of the page holds a secret of the run. `server.log` holds each such secret as `<secret>`.

`artifacts walkr-url [SESSION-ID]` prints one line: the private address of the Compare page on the origin of this server, `http://127.0.0.1:<port>/_walkr/compare/g/<secret>`, with `#<SESSION-ID>` when you give one. It runs `walkr-compare open`, which starts the live Walkr server when none runs. The command stops `walkr-compare open` after 20 seconds. The live Walkr server ends after its own idle time: 45 minutes with no use. It does not start this server. The command turns the Sheprd link of Walkr off for its own call, so Sheprd never gets the address on the Walkr port. The address is not in `status`, `--json status`, `/healthz`, the `start` lines or `server.log`.

| Exit | Meaning |
|---|---|
| 0 | Done: the address is on standard output. |
| 2 | The session is unknown, or the ID is not valid. |
| 3 | No server answer: the live Walkr server did not start in time, or this server does not run (run `artifacts start`). Also: this server runs from before the update and has no Walkr pass (run `artifacts off`, then `artifacts start`). |
| 4 | Walkr or Node is absent. |

The secret of the address is valid for one run of the live Walkr server. That server ends after 45 minutes with no use. A plain browser tab then needs a new address: run `artifacts walkr-url` again.

## Sheprd

`sheprd config set artifacts.url http://127.0.0.1:6790/` puts an Artifacts button in the activity bar of Sheprd. Give the port of your setup; through a port forward, the local port can differ from 6790.

`artifacts open` prints a URL. When `HERDR_ENV=1` and a Sheprd command is found, it also runs `sheprd browser open <url>`. It looks for the Sheprd command in this order: `sheprd` on `PATH`, `~/.local/bin/sheprd`, and the old path `~/.local/state/herdr/gpui/bin/herdr-gpui` of an old install.

## Exit codes

0 done, 2 refused input, 3 the server did not start or answer, or the remote store did not answer, 4 Walkr or Node is absent (`walkr-url`), 5 the scan stopped the upload. The exit codes of `walkr-url` are in [The Walkr pass](#the-walkr-pass).
