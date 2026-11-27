# artifacts

The optional kit module `artifacts`: a CLI that stores an HTML or Markdown file in a local artifact store, and a small web server on `127.0.0.1`. The server is the one local web app of the kit, with three sections: the page `/artifacts` with the stored pages, the Walkr page `/walkr` and the memory viewer `/memory/` (see [One web app, three sections](#one-web-app-three-sections)). It also has one event channel for a desktop app. The archive and restore routes change only the archive status in the store. The Walkr pass sends Compare and Feedback page writes to the live Walkr server, and the Memory pass one review write to the memory viewer. The artifacts part is Python 3, standard library only: no Node, no npm step and no database. The Walkr pass needs Walkr, and the Memory section needs the memory viewer; both run on Node.

| Path | What |
|---|---|
| `skills/artifacts/SKILL.md` | The skill: when to upload, the commands, the rule for the view link. |
| `skills/artifacts/scripts/artifacts` | The CLI: `setup`, `upload`, `list`, `open`, `archive`, `restore`, `delete`, `retention`, `doctor`, and `start`, `off` (`stop`), `status`, `events` and `login` for the server. |
| `skills/artifacts-server/SKILL.md` | The Claude Code command `/artifacts-server start \| off \| status \| walkr \| rotate`. |
| `prompts/artifacts-server.md` | The same command as a Pi prompt. |
| `server/artifacts_store.py` | The store and the configuration, shared by the CLI and the server. |
| `server/artifacts_server.py` | The server: one route table and one map from content type to view. |
| `server/login.py` | The admin login: the verifier file, the hash of the key, the sessions and the throttle. |
| `server/key_store.py` | The password systems of the admin key, for the CLI only: the Keychain, Bitwarden, Vault and the file store. |
| `server/events.py` | The event channel for a desktop app: the watcher, the kept events and the stream. |
| `docs/events.md` | The contract of the event channel. |
| `server/memory_front.py` | The Memory section: the memory viewer of `packages/memory` as a child process, and the pass to it. |
| `server/web/` | The style and the scripts of the pages: the Torch tokens (`theme.css`), the theme script (`theme.js`), the index page, the viewer page and the Markdown view, and the vendored `marked` and `highlight.js` (see `THIRD_PARTY_NOTICES.md`). |

The package is separate from `packages/tenantext`, because Pi loads every skill of a package entry. The CLI finds the server from its own real path, so a link to the CLI (for example `~/.local/bin/artifacts`) works. See the module guide `docs/guides/modules.md` of the kit.

## The store

`artifacts upload FILE` writes the file into `~/.local/share/tenant-artifacts/store/` (`$XDG_DATA_HOME/tenant-artifacts/store/` when that variable holds an absolute path), mode 0700. Each artifact is one directory `<store>/<slug>/` with the uploaded bytes in `source` and the facts in `meta.json`: `slug`, `title`, `fileName`, `contentType`, `repo`, `createdAt`, `byteSize`, and `updatedAt` and `revision` after a replace. The slug is 32 random URL-safe characters, and it does not start with `-`. A slug of an older upload can start with `-`: give it as `--replace=SLUG`, or after `--`, for example `artifacts delete -- SLUG`. The CLI builds the directory under a scratch name in the store, then renames it to the slug, so the server never shows a half-written artifact. An upload needs no running server. `upload` prints the viewer link `/v/<slug>`.

`artifacts upload FILE --replace SLUG` stores the new file under an existing slug, so the link stays. It keeps `slug` and `createdAt`, sets `updatedAt`, adds 1 to `revision` (an artifact without the key counts as 0), and takes the file name, the content type and the size from the new file. The title and the repo stay unless `--title` or `--repo` gives a new one. An unknown slug, a wrong extension or a scan finding changes nothing. The CLI first writes both new files beside the old ones. When that fails, it removes them, and the artifact does not change. Then it moves them over the old files with `os.replace`: first `source`, then `meta.json`. A reader always gets a whole file. Between the two moves, a reader gets the new bytes with the old facts, for example the old title and the old content type. When the second move itself fails, the artifact keeps that state, and the CLI says `cannot replace` and exits 2. A new `--replace` of the same slug repairs it.

`artifacts archive SLUG [SLUG ...]` moves items to the archive list. `artifacts restore SLUG [SLUG ...]` moves them back. Both commands check each slug before changing any item. Archive sets `archivedAt` to the current UTC time in `meta.json`. Restore removes that key. Neither changes the version or frees disk space. `upload --replace` keeps an archived item archived. Retention and `delete` still remove archived items under the same rules. `artifacts list` marks archived items in its last column.

`artifacts delete SLUG [SLUG ...]` deletes the named artifacts and prints one `deleted:` line for each. It deletes only a directory directly inside the store, not a symlink, whose name is a slug and whose `meta.json` can be read and names that slug. It checks each slug first: when one is not such an artifact, it deletes nothing and exits 2. For each artifact, it renames the directory to a scratch name in the store that starts with `.`, so the artifact leaves the list in one step, and then removes that directory. When the removal fails, the scratch directory stays: the command names its path and exits 2.

The repo of an upload is the `--repo` value. Without it, the CLI takes the name of the repository of the `origin` remote of the working directory (the last part of its URL, without `.git`), else the directory name of the main checkout, else no repo. It stores only the name, never the remote URL.

The old directory `~/.local/share/tenant-artifacts/data` of an earlier server design stays as it is.

## The server

`artifacts start` starts the server detached on `127.0.0.1:<port>` (default 6790). It prints the line `root: <URL of />` and, when Walkr is installed, the line `walkr: <URL of /walkr>`. Its last line is the URL of `/artifacts`. A second `start` starts nothing and prints the same lines. `start` writes the state file `~/.local/state/tenant-artifacts/server.json` right after the server process starts, and removes it when the start fails. `artifacts off` signals a PID only when `/healthz` on the configured port answers with the service `tenant-artifacts`, the user ID of the CLI and the same PID as the state file. `off` then also stops the live Walkr server of the default state directory, because the Walkr page is a section of this web app. It signals that server only when `/health` on the port of the Walkr record names the PID of the record and the protocol of this kit. The record must be private and current. Linux must show that your process owns every listener on the recorded port. On macOS or without that proof, `off` leaves Walkr running and prints a manual stop hint. The saved Compare sessions stay, and the next `walkr-compare` command starts a new Walkr server. A `walkr-compare wait` that runs at that moment ends with an error; run it again. `artifacts off --keep-walkr` leaves the live Walkr server running. Walkr counts as installed when the program `walkr-compare` is on the `PATH`. The server log is `server.log` in the same directory.

`artifacts status` prints the state, the health, the URL of `/artifacts`, the line `root:` and, with Walkr, the line `walkr:` with the word `open` or `closed`. `artifacts --json status` prints one object, for example:

```json
{"state": "running", "url": "http://127.0.0.1:6790/artifacts", "schema": 2, "pid": 12345, "port": 6790,
 "host": "127.0.0.1", "modules": ["artifacts", "walkr", "memory"],
 "pages": {"root": "http://127.0.0.1:6790/", "artifacts": "http://127.0.0.1:6790/artifacts", "walkr": "http://127.0.0.1:6790/walkr",
           "memory": "http://127.0.0.1:6790/memory/"},
 "walkr": {"socket": "open"}, "memory": {"state": "running"},
 "events": {"url": "http://127.0.0.1:6790/events/v1", "version": 1, "token_file": "/home/me/.local/state/tenant-artifacts/events-token"},
 "store_host": "HOST"}
```

- `state` is `running` or `stopped`, and no other word. `state` and `url` are always present.
- `url` is the URL of `/artifacts`. A server from before this version has no `/artifacts`, and its `/healthz` answer has no `schema` key. For that server, `url` and `pages.artifacts` are the root URL, and the text form says that `artifacts off` and `artifacts start` give the new pages.
- `pid` is present only when the server runs. `store_host` is present only when the key `remote` is set.
- `modules`, `pages.walkr` and `walkr` come from the `/healthz` answer when the server runs. When it is stopped, the CLI finds them with the same rule as the server. Without Walkr, `pages.walkr` and `walkr` are absent.
- `modules` has `memory`, with `pages.memory` and `memory.state` (`running` or `stopped`), when the memory viewer can start. See [The Memory section](#the-memory-section).
- `events` is present only when the server runs and has the event channel. It names the address of the channel and the file that holds its token, never the token. See [The event channel](#the-event-channel).
- The CLI builds each URL of `pages` from the configured port. No value of the Walkr record (no token, no port of the live Walkr server) is in the output.

`artifacts doctor` prints one line for Walkr: installed or not, and the live server open or closed. That line does not change the result `PASS` or `FAIL`.

The CLI counts a server only when its `/healthz` answer has the user ID of the CLI. A server of another user on the port is another program: `status` says `stopped`, `start` refuses the port and names `artifacts setup --port N`, and `upload` prints that no server runs.

The artifact server of an earlier kit version (`node server.mjs`) used the same default port, and `artifacts off` does not stop it, because `off` signals only its own server. When the program on the port answers `/healthz` with `{"status": "ok"}` and no `service` key, `start` and `doctor` say that it is probably that server. They name the command that finds its process, `ss -ltnp 'sport = :N'` on Linux or `lsof -nP -iTCP:N -sTCP:LISTEN` on macOS; end that process with `kill`.

The server answers `GET` and `HEAD`, archive and restore writes, and the requests it passes to Walkr and Memory. It admits a request only from a loopback peer with the host name `127.0.0.1`, `localhost` or `[::1]` in the `Host` header, with any port; else it answers 403. This stops DNS rebinding, and a port forward can use another local port.

| Path | Answer |
|---|---|
| `/` | The root page: a link to `/artifacts` and a link to `/walkr`. |
| `/artifacts/archive` | A plain list of archived items, newest first. It links to each viewer and loads no artifact or preview. Choose `Restore` to return an item to the index. |
| `/artifacts` | The index page: a table of the items outside the archive. Each row has an `Archive` button. The band links to the archive when it has items. The index has sortable columns, a filter and the retention setting. The page holds no frame when it loads: a preview is a whole page, so the index makes one only on demand, and each row shows a static tile with the type. In the table, the row under the pointer or with the keyboard focus (on its tile or its title) shows one live preview in a card near the row. The switch `Table` / `Gallery` shows the same artifacts as a grid of cards with the title, the type, the repo and the created time; a click on a card opens the viewer, and a `Sort` list sets the sort. The gallery shows a live preview only for the cards in view, at most 12 at one time, and removes a preview that leaves the view. At most 2 previews start at one time. A preview that needs more than 4 seconds frees its place for the next one and continues to load. A page above 1 MiB gets its preview only when the pointer or the focus rests on its card; the preview then stays while the card is in view. A narrow window gives one column. The `Repo` list shows a count for each repo. Choose a repo, or click its name in a row, to filter both views without clearing the text filter. A `repo:` word matches only the repo of that name, also typed by hand; for a name with spaces, write `repo:"<name>"`. Each other word matches a part of the title, the file name, the repo or the type. The view, the sort, the repo and the text filter are in the URL fragment, so a reload and a bookmark keep them; with no fragment, the page shows the table. The page asks `/api/state` every 3 seconds while it is visible, and takes the new rows when the value changes. A preview frame asks `/a/<slug>?thumb`; it has the `sandbox` attribute with no `allow-same-origin`, as the answer has the policy below. `/browse` redirects to `/artifacts`. |
| `/v/<slug>` | The viewer page. A bar shows a link to the index, the title, the file name, the type, the repo and the times, and the links `Newer`, `Older` and `Open alone`. `Newer` and `Older` skip archived items. An archived viewer shows `Archived` instead of these links. Below the bar, a frame shows the artifact with the sandbox tokens of `/a/<slug>`. When the artifact has a new version, the bar shows a note with a `Reload` button; the frame does not load again by itself. When the artifact is gone, the bar says so. The frame of a Markdown artifact gets its address from the script of the page, with `?theme=torch-dark` when the page shows Torch Dark; with no script, the page shows the frame in Torch Light. |
| `/a/<slug>` | The artifact. An HTML artifact goes out as stored. A Markdown artifact goes out as a page that holds the source as text and renders it in the browser with `marked`. A fenced code block with a language name gets syntax colors from `highlight.js`, which the page loads only when it has such a block. A language that `highlight.js` does not know stays plain text; the page does not guess a language. With the query `?thumb` (a preview of the index), the page loads no library past `marked`. With the query `theme=torch-light` or `theme=torch-dark`, the Markdown page shows that theme; each other value counts as no value. An HTML artifact keeps its own colors. |
| `/api/state` | `{"state": <text>, "count": <number>}`. The state is a hash of the slugs, their created times, their versions, their archive status and the retention setting. The version is the time of the last change, then ` r<revision>` when `revision` is above 0, so two changes in one second give two versions. `/api/state/<slug>` adds `"artifact": {"version": <text>}`, or `"artifact": null` when the artifact is gone. The answer can be up to 2 seconds old: the server keeps its last read of the store for 2 seconds, so many open pages cost one read. |
| `/walkr` | `303 See Other` to the Walkr Compare page on this origin, `Location: /_walkr/compare/g/<secret>`. The server first runs `walkr-compare --here open`, which starts the live Walkr server when none runs. A text page instead when Walkr is not installed (200), when the request comes from a foreign page or, on Linux, not provably from the user of the server (403), or when the program on the port of the Walkr record is not the recorded server or no address came (503). See [the page /walkr](#the-page-walkr). The secret is not a field of the Walkr record, and the answer holds no field of the record (no port, no PID, no agent token). |
| `/healthz` | `{"status": "ok", "service": "tenant-artifacts", "pid": <pid>, "uid": <user ID>, "schema": 2, "port": <port>, "modules": [...], "pages": {...}, "login": {"path": "/login"}}`. Outside the login. `pages` holds paths: `root`, `artifacts` and, with Walkr, `walkr`. With Walkr, `modules` has `walkr` and the key `walkr` is `{"socket": "open"}` or `{"socket": "closed"}`. |
| `/d/<slug>` | The download of an artifact: the stored file, unchanged, with `Content-Disposition: attachment` and the empty sandbox policy. The file name is the last path part of the original name with control characters removed and a quote as `_`; a name that is hidden, ends with a dot, or is longer than 200 bytes becomes the slug with the extension of the content type; a name that is not ASCII also goes into `filename*`. |
| `/_walkr/compare/...`, `/_walkr/feedback/...`, `/theme.css`, `/theme.js` | The Walkr Compare page, passed to the live Walkr server (see [The Walkr pass](#the-walkr-pass)). |
| `/static/<file>` | The style and script files of `server/web/`. Each answer has `Cache-Control: no-cache` and an `ETag` of the content: the browser asks each time, so a new kit version shows at once, and a matching `If-None-Match` gets 304 with no body. Chrome does not cache the files that a sandboxed artifact page loads, so these files come in full each time. |

`POST /api/archive/<slug>` and `POST /api/restore/<slug>` require a loopback peer and Host. Send exactly one `Origin` that matches the HTTP host and port. Send `Sec-Fetch-Site: same-origin` or omit it. The body must be a JSON object with `Content-Type: application/json` and a `Content-Length` of at most 1024 bytes. The routes allow no cross-origin requests. Both routes require an admin session or the local CLI token. Linux also requires the socket to belong to the server user.

Each `/a/<slug>` answer has the policy `sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads; frame-ancestors http://<host>`, where `<host>` is the admitted `Host` value of the request. So only a page of this server can frame an artifact. The policy does not use `'self'`, because the web view of Sheprd then refuses the frame. A `[::1]` host keeps `'self'`, because a host source of the policy cannot hold an IPv6 address. With no `allow-same-origin`, a stored page gets an opaque origin and cannot act as the server origin. The index and the viewer are pages of the server origin. Their policy allows only the scripts, the styles, the frames and the requests of the server origin, and no inline script or style. Each value of `meta.json` goes into them escaped.

## The login

The pages of the server need a login: the user `admin` and a key. No setting turns the login off.

- The first `artifacts start` makes the key when no verifier file exists: 32 random bytes, written as base64url. It writes the key into a password system, reads it back and compares it, and only then writes the verifier file. Then it starts the server. `start` prints one line `login:` with the store and the item before the URL. The server never gets the key or a credential of a store.
- The verifier file is `~/.config/tenant-artifacts/admin-login.json`, mode 0600. It holds the user name, the scrypt parameters, the salt, the hash, the store kind, the item reference, the creation time and a generation ID. It never holds the key. The server checks the file at each request that needs the login, so a new key ends each session with no restart. With no valid verifier file, the server signs in nobody.
- `artifacts setup --key-store auto|keychain|bitwarden|vault|file` writes the key `keyStore`. The default `auto` takes the first usable store in this order: the macOS Keychain when `security` works (macOS only), Bitwarden when an unlocked session exists, Vault when `VAULT_ADDR` is set and `vault token lookup` works. `auto` never takes the file store. A store whose check fails (a timeout, a program that does not start, a `bw` with an old Node) counts as not usable in `auto`: one line names the reason, and the order goes on. With an explicit store, the same failure exits with code 6 and names the fix.
- With no usable store, `start` exits with code 6, starts no server and writes no verifier file. The message names the two ways out: unlock a password system (for Bitwarden, sign in to `bw` first, then run `export BW_SESSION="$(bw unlock --raw)"` with shell tracing off and retry in that shell), or choose a store with `artifacts setup --key-store`. A store that takes the key but gives another value back also exits with code 6 and writes no verifier file; the message names the item.
- `artifacts login status` prints the store, the item, the creation time, the path of the verifier file and whether the running server uses it. `artifacts --json login status` prints the same facts as one JSON object. Neither prints the key. Both say when a `pending` entry exists.
- `artifacts login rotate` writes a new key into the store of the setting. With the setting `auto`, it uses the store of the item that holds the key now, and it edits that item. It prints the store and the item. First it reads the item of the verifier: the item of the `pending` entry when one exists, else the active item. A `pending` entry of a new Bitwarden item has no item id yet, so then it reads the active item. It keeps the one hash that fits the key of that item. When the read fails, or the item holds a key that no hash fits, it changes nothing and exits with code 6. Then it writes the verifier with the kept hash and a second entry `pending`, the hash of the new key: the server then takes the stored key and the new key, and the sessions stay. Then it writes the new key into the store and reads it back. Only after a good read-back does the verifier get the new key alone and a new generation, which ends each browser session. A rotate that fails after the `pending` write keeps that entry, so the key that the store holds works, whichever one it is; the message says so. A new `artifacts login rotate` makes it whole when the item of the verifier can be read; else run `artifacts login rotate --fresh`. In Pi and Claude Code, `/artifacts-server rotate` runs it.
- `artifacts login rotate --fresh` writes a new key into a new item of the store of the setting, as a first start does, and reads no old item. So it recovers when one store works. The old Bitwarden item stays in its store; the Keychain, Vault and file stores have one item each, which gets the new key. It keeps the active hash until the read-back, and a good read-back ends each browser session. A failed first start or `--fresh` can leave an extra Bitwarden item of the same name; `artifacts login status` names the item in use.

The stores:

| Store | Item | Write and read-back |
|---|---|---|
| `keychain` | An internet password: server `127.0.0.1`, the port, account `admin`, protocol `http`. | `security -i` reads the `add-internet-password -U` command from standard input; `find-internet-password -w` reads it back. |
| `bitwarden` | A Login item `tenant-artifacts admin (<host>)` in no folder, user name `admin`, the key as the password, the URI `http://127.0.0.1:<port>`. | The CLI encodes the item JSON as `bw encode` does (base64 of the UTF-8 text), then runs `bw create item` or `bw edit item <id>`, each from standard input; `bw get item <id>` reads it back. The CLI runs `bw` only in two forms. A direct Node script (its first line is `#!/usr/bin/env node`, or an absolute path that ends in `/node`): the CLI takes the real path of that Node (for `env node`, the first `node` on the `PATH`), runs `<node> --version`, needs version 20 or later, and runs each `bw` call with that same Node. A native program (an ELF or Mach-O file) runs directly. Each other file, for example a shell wrapper, does not run, because it can start an old Node itself; with `auto` one line names the file and the order goes on, and with `bitwarden` the CLI exits with code 6. An older Node can throw away the stored keys of an unlocked session. The CLI uses `BW_SESSION` first. Without a nonblank value, it can read an optional cache younger than 12 hours: `$XDG_RUNTIME_DIR/tenant-credsync/bw-session`, or `/dev/shm/tenant-credsync-<uid>/bw-session` when `XDG_RUNTIME_DIR` is empty or unset. The CLI never writes this cache. The session goes to `bw` only in its environment. |
| `vault` | The KV field `key` at `kv/tenant-artifacts/<host>/admin`. | `vault kv put -mount=kv ... key=-` with the key on standard input; `vault kv get -field=key` reads it back. |
| `file` | `~/.config/tenant-artifacts/admin-key`, mode 0600. | Only when you choose it: for a computer with no password system. |

`<host>` is the short host name. The key is in no argument of a store program, no output and no log line. Each store program runs by its absolute path and gets an environment from an allow list:

| Program | Variables |
|---|---|
| each | `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LC_*`, `TZ`, `TMPDIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `SSL_CERT_FILE`, `SSL_CERT_DIR` |
| `security` | only these |
| `bw` | also `BW_SESSION`, `BITWARDENCLI_*`, `NODE_EXTRA_CA_CERTS`, `NODE_NO_WARNINGS` and the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`, also in lower case) |
| `vault` | also `VAULT_*` and the proxy variables |

So `vault` and `security` get no `BW_SESSION`, `bw` gets no `VAULT_TOKEN`, and `security` gets no proxy variable. A Vault token helper that needs another variable (for example `SSH_AUTH_SOCK`) is not supported: set `VAULT_TOKEN` instead. The verifier file and the `file` store are synced to the disk before and after each replace.

The browser session:

- `GET /login` is a plain HTML form that works with no script. Its page has its own policy with `form-action 'self'`; each other page keeps `form-action 'none'`. `POST /login` checks the user name and the key in constant time. Its `next` field takes only a relative path of this server that starts with one `/`; else the target is `/artifacts`. The log holds no posted body.
- A session lives in the memory of the server. It ends 7 days after its last request, at a new key, and at a restart of the server. The cookie is `tenant_artifacts_<port>`, because a browser sends a cookie of `127.0.0.1` to each port: `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age` of 7 days. It goes out again at most once a day. It has no `Secure` flag, because the server speaks plain HTTP on loopback.
- After 5 failed logins, the server refuses each login for 30 seconds with 429 and `Retry-After`. One counter serves the server, because each peer is loopback.
- The band of each page of the server has the link `Log out`, a `GET /logout`: the artifacts pages, the Memory section, and the Walkr Compare page when this server passes it (not on the own port of Walkr and not on a public request). A cross-site request carries no `SameSite=Strict` cookie, so it ends no session. `POST /login` and `/logout` refuse a request whose `Origin` or `Sec-Fetch-Site` names another origin, as the archive writes do.
- Behind the login: each local request but the routes below, also `/`, `/artifacts`, `/v/`, `/a/`, `/d/`, `/api/state`, `/walkr`, the Walkr pass, `/memory/` and the archive writes. A page request with no session gets `303` to `/login?next=<path>`; a JSON, download, write or pass request gets 401 with no data. The check comes before the passes; the Walkr pass and the Memory pass keep their own headers to the children.
- Outside the login: `/login`, `/logout`, `/healthz` (the CLI asks it before it knows the program on the port; it holds no store data), `/static/` (kit files with no user data: a sandboxed artifact frame has an opaque origin and sends no cookie), `/events/v1` (its own token) and each public request of `walkrPublicOrigin`.

The command line: each run of the server writes a new local token to `~/.local/state/tenant-artifacts/cli-token`, mode 0600. The CLI sends it in the header `X-Tenant-Artifacts-Token`, only to a server whose `/healthz` PID is the PID of the state file; the server compares it in constant time. It is not the event token. The CLI never reads a password system for a call. `status` and `login status` use it to ask the server for its verifier. A running server from before the login gets one `note:` line in `start` and `status`: run `artifacts off`, then `artifacts start`.

## The look

The pages of the server origin (the root page, the index, the viewer, the text pages of `/walkr` and the page of an unknown address) have the Torch design of Walkr: the navy band at the top with the yellow mark of the page, teal actions, and the same chips, fields and focus ring. The Markdown view of an artifact has the same colors. An HTML artifact keeps its own colors inside its frame.

- The colors and the fonts are the Torch tokens in `server/web/theme.css`. The values are a copy of the blocks `torch-light` and `torch-dark` of `packages/walkr/src/theme.css`, the source of the values. The package has its own copy because it works with no Walkr. A test of `tests/test_artifacts.py` compares the two files when both exist: change the values in Walkr first, then in the copy.
- The theme is Torch Light for each reader. It is Torch Dark when the reader chose a dark theme: the value of the browser storage key `human-review:theme`, the key of Walkr, is `torch-dark`, `lavender-dark`, `dark`, `plum`, `night` or `statue-dark`. The Walkr page runs on this origin, so one choice serves both. The `Theme` list of the band (Torch Light, Torch Dark) writes the same key, so Walkr follows a choice made here. The system setting of the reader (`prefers-color-scheme`) does not count.
- `theme.js` is a plain script in the head of each page, before the styles. It sets the theme before the first paint, so a page never shows the other theme first. With no script, a page shows Torch Light.
- An artifact answer is sandboxed and has no storage. So the page that frames a Markdown view gives it the theme in the query `theme`, and the viewer sends the new name as a message when the reader changes the theme.

## Retention

`artifacts retention` prints the setting. `artifacts retention <days>` (1 to 3650) sets the key `retentionDays`; `artifacts retention none` removes it. With no setting, the server deletes nothing. The server sweeps at its start and then once an hour, and it reads the setting at each sweep. A sweep deletes only a directory of the store whose name is a slug, whose `meta.json` can be read, and whose last change is older than the limit. Before it deletes an artifact, it takes the lock of `--replace` and reads `meta.json` again, so an artifact that a replace just renewed stays. It deletes as `delete` does; the server log names a scratch directory that stays. The last change is `updatedAt` when it exists, else `createdAt`. The `expires:` line of `upload` and `artifacts list` use the same rule.

## Configuration

`artifacts setup [--port N] [--remote HOST | --local] [--walkr-public-origin ORIGIN | --no-walkr-public-origin] [--key-store STORE]` writes `~/.config/tenant-artifacts/config.json` (in `$XDG_CONFIG_HOME/tenant-artifacts/` when that variable holds an absolute path) with mode 0600, and keeps each other key. Each command works with no configuration file. The keys `origin`, `tokenFile` and `clone` of an earlier design stay in the file; the CLI ignores them, and `artifacts doctor` names them.

## A remote store over SSH

Use a remote store when the agents run on one computer and you view the pages on another, for example in Sheprd on your desktop computer, which you reach over SSH. On the computer of the agents, run `artifacts setup --remote HOST`. HOST is an SSH destination: a host alias of your SSH configuration, a host name, or `user@host`, of letters, digits, `.`, `_` and `-`. `artifacts setup --local` removes the key `remote`. The global option `--here`, for example `artifacts --here list`, uses the store of this computer for one call.

With the key, `upload`, `list`, `archive`, `restore`, `delete` and `open` run `artifacts --here <command>` on HOST with one `ssh` call each, and give its output and exit code. `ssh` runs with `BatchMode=yes`, so it asks for no password: HOST needs a key login that works without a prompt. HOST needs the `artifacts` command on its `PATH` or in `~/.local/bin`. The other commands work on this computer. `doctor` also prints `remote: HOST` and checks that `artifacts` on HOST answers.

`upload` scans the file on this computer first. Only after that scan do the bytes, the file name, the title and the repo name go to HOST, on the standard input of `artifacts --here upload - --name FILENAME`, with the size and the SHA-256 of the file. A CLI outside a kit tree has no scanner: it warns and sends the file without a scan, as it stores a local upload. HOST refuses a stream that does not match the size and the hash, so a connection that ends in the middle stores nothing. HOST scans the file again and stores it; this computer stores nothing. The output has one more line, `on: HOST`. The `view:` link and the address of `open` are valid on HOST, not on this computer. `open` starts no browser for a remote store. `list`, `archive`, `restore`, `delete` and `open` send only the command and the slugs.

`artifacts upload - --name FILENAME` reads the file from standard input. Only the last path part of the name counts.

The same key moves the Compare sessions of Walkr to HOST: `walkr-compare` then runs its commands there (see "Remote mode" in `packages/walkr/docs/compare.md`).

When `ssh` gets or keeps no connection (exit 255), when HOST has no `artifacts` command, or when HOST gives no answer in time, the command exits 3. The message names HOST, says that the file is not stored, and names `artifacts setup --local` and `artifacts --here`. One case is open: a connection that ends after HOST finished the command. The message names it, and `artifacts list` shows the store of HOST.

## The secret scan

When the CLI runs from a kit tree, it runs `scripts/scan.sh --level warn tree` of the kit before each upload. The scanner gets a copy of the file in a scratch Git repository. The copy holds the bytes that the CLI read, the same bytes that go into the store. A secret or policy finding, or a scanner that does not run (for example, no Betterleaks binary), stops the upload with exit 5, and the store gets nothing. Outside a kit tree, the CLI prints one warning line and stores the file.

### Test seams

For tests only, not settings. Each variable holds a command line (shell words, parsed with `shlex`), and the CLI prints one warning line when it is set.

- `ARTIFACTS_SCAN_COMMAND` replaces the kit scanner. The command runs in the scratch repository; exit 0 is a clean scan, exit 1 is a finding, and another exit is a scanner that could not run.
- `ARTIFACTS_SSH_COMMAND` replaces the program `ssh` of the remote store. It gets the same arguments as `ssh`: the options, `--`, the host and the remote command line.

## One web app, three sections

The server is the one local web app of the kit. It has three sections on one port, and each page shows the same band: the three links Artifacts, Walkr and Memory, and the Theme list.

| Section | Address | Who answers |
|---|---|---|
| Artifacts | `/artifacts`, `/v/<slug>` | This server, from the store. |
| Walkr | `/walkr`, then the shared page under `/_walkr/compare/`, with Feedback routes under `/_walkr/feedback/` | The live Walkr server, a Node process of `packages/walkr`, through [the Walkr pass](#the-walkr-pass). |
| Memory | `/memory/` | The memory viewer of `packages/memory`, a Node child process of this server, through [the Memory pass](#the-memory-section). |

- Each section draws the band itself, from the same small markup (`nav.app-nav` with the three links) and the same token names. No section is inside a frame of another one.
- The theme is Torch Light, or Torch Dark when the reader chose a dark theme. One stored choice (the `localStorage` key `human-review:theme`, the key of Walkr) serves each section. The Walkr page keeps its nine themes; a dark one gives Torch Dark in the other sections.
- The Walkr page has the three links only when it comes through this server. On the own port of the Walkr server it has none, because the other sections are not there.
- `artifacts start` starts the web app and the memory viewer. The live Walkr server starts with the first use of `/walkr` or of a `walkr-compare` command. `artifacts off` stops all three.
- A section whose package is absent stays in the band: its page says in one sentence what is missing.

## The Memory section

`/memory/` shows the memory viewer of the kit package `packages/memory` (see its README): a read-only page for the memories of several memory systems. The artifacts package works without that package: the section then says that the viewer is not in this kit.

- The viewer is a child process of this server: `node packages/memory/server.mjs --child`, on `127.0.0.1` with a free port. It starts with the server, starts again at a request when it is gone, and stops at `artifacts off`. It also ends by itself when this server is gone.
- Sign-in between the two: the viewer has no login of its own. This server writes a secret of the start to the standard input of the child and adds it to each passed request in the header `X-Tenant-Artifacts-Parent`. The viewer refuses each request without it with 401. The secret is in no argument, no environment variable, no file and no log line, and a browser never gets it.
- The pass sends a request only when its method and its whole raw path are in one exact list (`PASSED` in `server/memory_front.py`): `GET /memory/`, the files of the page, the API routes `sources`, `overview`, `recent`, `search` and `sources/<id>/browse|search|item`, and `POST sources/<id>/review`. A query passes only on an API route and only with the characters of an encoded form. A path with `..`, an encoded dot, a double slash, an absolute URL, a fragment or another prefix matches nothing and stays here: 404, or 405 for a `POST`.
- The target is always `127.0.0.1` with the port of the child and the path below `/memory`. No part of a request chooses the host or the port. An answer of the child with a redirect status never goes back: it becomes 502.
- Only the headers `Host`, `Origin`, `Accept`, `Content-Type`, `Sec-Fetch-Site` and `X-Tenant-Memory-Action` go to the child. A request with an `Origin` header that is not an HTTP origin with a loopback name gets 403.
- The viewer needs Node 24 or later and its dependencies (`install.sh --with memory`). It takes the first `node` of version 24 or later on the `PATH` of the server. When Node 24, the package or the dependencies are absent, the server still starts, `modules` has no `memory`, and `/memory/` says in one sentence what is missing.
- The sources come from the settings file `~/.config/tenant-artifacts/memory-sources.json` (mode 0600; each credential is the path of a file with mode 0600). With no settings file the viewer shows synthetic sample data and says so. A settings file that is not private stops the viewer, and `/memory/` says so.
- `artifacts --json status` has `memory` in `modules`, `pages.memory` and `"memory": {"state": "running"}` (or `stopped`).

Warning: with a settings file, `/memory/` shows private memory. It is behind [the login](#the-login), and on Linux the Memory pass also accepts only a client socket that belongs to your user.

## The event channel

`GET /events/v1` is one live channel for a desktop app, for example the Herdr app: an event stream over plain HTTP. A client gets the present state first (the counts and the Compare sessions that wait for a pick), then one message for each change: an artifact was added, changed, archived, restored or removed; a Compare session waits for a pick; a result was submitted; the agent received a result; a module started or stopped. A client that comes back with the ID of its last message gets the events that it missed, or the state again. [The contract](docs/events.md) has each message, the order rules, the limits and the version rule.

- Sign-in: the client sends `Authorization: Bearer <token>`. The server writes a new token at each start to `~/.local/state/tenant-artifacts/events-token`, mode 0600. The token is in no status answer, no address and no log line. The server compares it in constant time.
- A request with an `Origin` or a `Sec-Fetch-Site` header gets 403 before the token check, so no page in a browser opens the channel. The channel is on the port of the server, which listens on `127.0.0.1` only.
- Limits: 8 clients, 16 KiB for one message, 256 waiting messages for one client. A client that does not read is closed.
- The server reads its own store and the Compare session records of `~/.local/.walkr/compare` every 2 seconds while a client is connected. It sends the Walkr server no request and reads no agent token. An event can arrive up to 2 seconds late.
- `artifacts events` is a test client: it prints each message as one line. `--count N` ends after N messages.

## The Walkr pass

The server passes the requests of the Walkr Compare page to the live Walkr server, so the page works on the port of this server and through a port forward. Compare and Feedback share that page.

- The pass sends a request only when its method and its path are in one exact list (`PASSED` in `server/walkr_front.py`). `GET`: the page, its Compare and Feedback frames, its scripts and styles (also `a2ui.js`, `a2ui.css`, `feedback.js` and `feedback.css`), `/theme.css`, `/theme.js`, the session rows and the view of one Compare or Feedback session. `POST`: only `seen`, `submit` and `rate` of one Compare session, and `seen`, `expand`, `respond` and `rate` of one Feedback session. Each other request stays here: a `POST` gets 405, another path 404, and a `HEAD` gets the answer of this server. A path with a query is never passed.
- The pass sends the method, the path, the `Host` header, the `Origin` header, the content type, the page token header and the body unchanged; a body can have up to 8 MiB. It gives back the status, the content type, the policy headers and the body. The page token and the checks of the live Walkr server decide each request.
- A request with an `Origin` header that is not an HTTP origin with a loopback name (`127.0.0.1`, `localhost` or `[::1]`, any port) gets 403.
- The pass parses the Walkr record, keeps only its port and its PID, and never sends its agent token. With no live Walkr server, a passed path gets 503 with a JSON reason that names `artifacts walkr-url`. One deadline of 10 seconds covers the check that the live Walkr server answers and the exchange with it. It does not cover the upload of the body from the client.
- The path of the page holds a secret of the run. `server.log` holds each such secret as `<secret>`.

`artifacts walkr-url [SESSION-ID]` prints one line: the private address of the Compare page on the origin of this server, `http://127.0.0.1:<port>/_walkr/compare/g/<secret>`, with `#<SESSION-ID>` when you give one. It runs `walkr-compare --here open`, which starts the live Walkr server when none runs. `--here` keeps that command on this computer also with the key `remote`, because the page shows the live Walkr server of this computer. The command stops `walkr-compare open` after 20 seconds. The live Walkr server ends after its own idle time: 45 minutes with no use. It does not start this server. The command turns the Sheprd link of Walkr off for its own call, so Sheprd never gets the address on the Walkr port. The address is not in `status`, `--json status`, `/healthz`, the `start` lines or `server.log`. The page `/walkr` gives the same address in a redirect (see [the page /walkr](#the-page-walkr)).

| Exit | Meaning |
|---|---|
| 0 | Done: the address is on standard output. |
| 2 | The session is unknown, or the ID is not valid. |
| 3 | No server answer: the live Walkr server did not start in time, or this server does not run (run `artifacts start`). Also: this server runs from before the update and has no Walkr pass (run `artifacts off`, then `artifacts start`). |
| 4 | Walkr or Node is absent. |

The secret of the address is valid for one run of the live Walkr server. That server ends after 45 minutes with no use. A plain browser tab then needs a new address: open `/walkr` again, or run `artifacts walkr-url` again.

### The page /walkr

The link `Walkr` of the root page opens `/walkr`. With Walkr installed, the server runs `walkr-compare --here open` as `artifacts walkr-url` does: the same environment and the same time limit of 20 seconds. That command starts the live Walkr server when none runs. It also replaces a live Walkr server of an older protocol: it stops that server when its `/health` answer names the PID of the record. The answer is `303 See Other` with the path of the Compare page in `Location`, so the browser stays on the port of this server, also through a port forward. `HEAD` gets the same answer with no body.

The secret of the address is a capability: its holder can read the sessions and submit picks. The live Walkr server makes the secret at its start; the secret is not in the Walkr record. `/walkr` gives the address only to a request that passes these checks, in this order. A refused request runs nothing.

1. The headers (403):
   - `Sec-Fetch-Site` is absent, or one header with the value `none`, `same-origin` or `same-site`. Case and spaces at the ends do not count. The server refuses `cross-site`, an empty, combined or unknown value, and two such headers.
   - An `Origin` or a `Referer` header comes at most once and names an HTTP origin with a loopback name and any port. The pages of this server send no `Referer`.
   - Servo, the web view of Sheprd, sends `same-origin` for a click on the link of the root page. It sends `cross-site` for an address that you type or that Sheprd opens, so such a request gets the text page. That page has the link `Open the Walkr page`, and a click there passes. The page cannot be framed, so a foreign page cannot make that click. These Servo facts come from its source at the Sheprd pin, not from a capture of its requests.
2. At most 4 requests run the user check of step 3 at one time. One more request gets 503 at once; it waits for nothing.
3. The user (403). On Linux, the TCP tables `/proc/net/tcp` and `/proc/net/tcp6` name the user of each socket. The address goes only to a client socket of the user of the server. The server refuses another user, a socket with no line, a table that cannot be read, and a read that stops at a limit before the line: 100000 lines or 1 second. A line found before a limit counts. The kernel adds the line of a client socket before the server accepts the connection, so the server does not try again. No line can also mean a read that stopped at a limit, a closed client or a client in another network namespace. On macOS, the Python standard library cannot tell the user of a TCP peer, so this check adds no user restriction. Local requests still need an admin session or the CLI token.
4. One request at a time goes past this point. Only a request that passed step 3 waits here. On Linux, step 3 refuses a request of another user, so such a request never makes a request of yours wait. On macOS, step 3 does not check the socket owner. A request that waits more than 20 seconds gets 503.
5. The Walkr record (503). `walkr-compare open` takes the record `~/.human-review/server.json` of its own protocol as live when any program answers on its port, and then sends the agent token of the record to that port. The record stays after the live Walkr server ends, and another program can get that port later. The rule of this check: `walkr-compare open` runs only when the evidence is complete and unambiguous. Any doubt is a refusal with one fixed text page. That page names `artifacts walkr-url`, which runs `walkr-compare open` in a shell with no such check, and tells you to remove the old record first when no Walkr server of yours runs.
   - On Linux, the server reads the listening sockets of that port in the TCP tables: both tables, each address. Each one must be an open file of the recorded process (`/proc/<pid>/fd`). Linux prints the listening sockets of a table before its other sockets, so the read ends at the first other socket, and many connections on a busy host do not count against the limit of 100000 lines. A read that stops at a limit, or a table that cannot be read, gives no answer and refuses; the server never uses a part of the read. This look is a snapshot: it does not prove which process serves a later request.
   - On Linux, a listener of another process on that port refuses, also one that cannot get the connection to `127.0.0.1`: for example an IPv6-only listener on `::`, a listener on `::1` or `127.0.0.2`, or one bound to another network interface. The reason: the TCP tables show neither the IPv6-only flag nor the bound interface, so the server cannot tell such a listener from one that gets the connection, and a wrong pass can send the agent token to that process. This is a known limit: such an unrelated listener on the same port number makes `/walkr` refuse a healthy Walkr server.
   - On macOS, `/health` on that port must name the PID of the record and a protocol that fits the record. For a record of the protocol of this server, `walkr-compare open` sends the token, so `/health` must name that protocol. For a record of an older protocol, `walkr-compare open` replaces that server itself and sends it no token, so `/health` must name the protocol of the record. Each other answer refuses. `/health` is a claim of the listener, not a proof.
   - When no program listens there, `walkr-compare open` starts a new server, so the server runs it. A record that the server cannot parse counts as no record: not valid JSON, larger than 64 KiB, or a port or a PID that is not a positive whole number. The check and the run are two steps: a program that takes the port between them is not seen.

With Walkr absent, the text page says so (status 200). When `walkr-compare open` gives no address, the text page gives a fixed reason and the exit code of `walkr-compare` (status 503), and `server.log` gets the same reason. No output of `walkr-compare` goes to the page or to the log; `artifacts walkr-url` shows its error output, with each secret as `<secret>`. The log line of the redirect holds the path `/walkr` only, and the line of the next request holds the secret as `<secret>`.

### A public origin for the Walkr page

A reverse proxy on another computer can show the Compare page on your private network, for example at `https://walkr.example.org`. The proxy has the entry guard: a private-network rule and a login. The page is as safe as that login. The server adds no entry secret of its own.

`artifacts setup --walkr-public-origin https://walkr.example.org` writes the key `walkrPublicOrigin`, and `artifacts setup --no-walkr-public-origin` removes it. The value is exactly `https://NAME` or `https://NAME:PORT`: a DNS name, no IP address, no loopback name, no path, no query, no user part, and a port from 1 to 65535 that is not 443 (write no port for 443). Setup refuses each other value and writes nothing. This server and the live Walkr server read the key at their start: after a change, run `artifacts off` and `artifacts start`. A value in the file that does not fit the rule gives one line in `server.log`, and the server then behaves as with no key. Without the key, each check is as before.

A request is public when its TCP peer is loopback and its one `Host` header is the host of the key: the name, with the port only when the key names one. A browser sends no port for 443. Two `Host` headers, or a `Host` that is neither loopback nor the public host, get 403 as before. A public request reaches only these routes; each other route answers 404 with no data, also a route that a later version adds:

| Route | Answer for a public request |
| --- | --- |
| `GET /walkr` | The 303 redirect to the page, after the checks of [the page /walkr](#the-page-walkr). `Origin` and `Referer` must name the public origin. The user check stays: on Linux the client socket must belong to the user of this server, so the SSH forward must log in as that user. |
| The pass list (`PASSED`: the page, its frames, scripts and styles, `/theme.css`, `/theme.js`, the session rows and views) | Passed to the live Walkr server with `Host` and `Origin` unchanged. An `Origin` must be the public origin. |
| Compare `POST`: `seen`, `submit`, `rate`. Feedback `POST`: `seen`, `expand`, `respond`, `rate`. | Passed only with exactly one `Origin` header equal to the public origin (scheme, lower-case host, port). No `Origin`, two, `null` or another origin: 403, and the live Walkr server gets nothing. |
| `/healthz`, `/`, `/artifacts`, `/a/`, `/v/`, `/d/`, `/api/state`, `/static/`, the archive and restore writes, `/memory/`, the event channel | 404 with the page "This address names no page of this server". |

The live Walkr server checks the public host too: see "A public origin behind a reverse proxy" in `packages/walkr/docs/compare.md`.

The proxy contract:

- The proxy sends the `Host` header of the browser unchanged. A proxy that rewrites `Host` to a loopback name makes each client of the proxy a local client: it can reach local routes such as `/healthz`; the artifact store and Memory viewer then depend on the artifacts login instead of the public route restrictions. That is forbidden, and this server cannot detect it.
- The proxy sends the `Origin` header of the browser unchanged and adds no `Origin` of its own.
- The private-network rule and the login stay in front of the pass to the forward. The proxy removes `Authorization`, `Cookie` and the headers of its login (for example `X-Authentik-*`) before the pass.
- The proxy sends the request through an SSH forward to the loopback port of this server, so the peer is loopback. The forward logs in as the user of this server: on Linux the user check of `/walkr` reads the socket of `sshd`, which belongs to that login.
- The SSH forward listens on `127.0.0.1` of the proxy computer only, or on a Unix socket with mode 0600. No other user, container or service of the proxy computer may reach it, because each connection to it counts as a request that passed the gate.
- Add no access log to the proxy site: the page path holds the page secret. The secret changes at each start of the live Walkr server.
- The proxy keeps the policy headers of the answers unchanged, with no rewrite of `Content-Security-Policy`. It adds no `frame-ancestors` that opens the page to another origin.
- After each change of the key: `artifacts off`, `artifacts start`, and a restart of the live Walkr server. A server that holds an older key refuses the public requests.

A generic Caddy site, with the SSH forward on port 6791 of the proxy computer:

```caddyfile
walkr.example.org {
    @outside not remote_ip private_ranges
    respond @outside "Private network access only" 403
    # The login of your proxy goes here, for example a forward_auth block.
    reverse_proxy 127.0.0.1:6791 {
        header_up -Authorization
        header_up -Cookie
    }
}
```

There is no `header_up Host` line: Caddy then sends the `Host` of the browser.

## Sheprd

`sheprd config set artifacts.url http://127.0.0.1:6790/` puts an Artifacts button in the activity bar of Sheprd. Give the port of your setup; through a port forward, the local port can differ from 6790.

`artifacts open` prints a URL. When `HERDR_ENV=1` and a Sheprd command is found, it also runs `sheprd browser open <url>`. It looks for the Sheprd command in this order: `sheprd` on `PATH`, `~/.local/bin/sheprd`, and the old path `~/.local/state/herdr/gpui/bin/herdr-gpui` of an old install.

## Exit codes

0 done, 2 refused input, 3 the server did not start or answer, or the remote store did not answer, 4 Walkr or Node is absent (`walkr-url`), 5 the scan stopped the upload, 6 no password system can take the admin key, or the store did not take it (`start`, `login rotate`; see [The login](#the-login)). The exit codes of `walkr-url` are in [The Walkr pass](#the-walkr-pass).
