# okknow details

Read this file when you need tool names, the configuration, troubleshooting, or the install steps.

## Configuration

| Item | Value |
|---|---|
| Origin | The `origin` of the user config file, or `OKKNOW_ORIGIN`. With both, they must be equal. `okknow origin` prints it. |
| User config file | `~/.config/okknow/config.json` (`$XDG_CONFIG_HOME/okknow/config.json` when that variable is set; `OKKNOW_CONFIG` names another file). A relative `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` or `OKKNOW_CONFIG` is ignored. Mode 0600. It holds `origin`, and on a server host `volume`; setup keeps every other key. It never holds a credential. The CLI refuses the file when it is a link, belongs to another user, or a group or other user can write it. |
| MCP endpoint | `<origin>/mcp` |
| Document API | `GET <origin>/api/document?docName=<doc>` (exact content) |
| Credentials | `OPENKNOWLEDGE_USERNAME` and `OPENKNOWLEDGE_PASSWORD` in the environment of the agent, for HTTP Basic authentication. The user exports them in the startup file of the shell. |

The origin form is `https://<host>[:port]`. `http` is allowed only for a loopback host (`127.0.0.1`, `::1`, `localhost`): a server on the same computer. An origin has no path, no user and no query.

## Setup

`okknow setup` is the wizard that writes the user config:

1. It asks for the origin of your own OK server. It suggests the origin of the existing config or of `OKKNOW_ORIGIN`, else nothing.
2. It checks the origin form.
3. It probes the origin without credentials: `reachable` (an HTTP answer from `/`) and `mcp` (an answer from `/mcp`, normally HTTP 401).
4. It asks `Send OPENKNOWLEDGE_USERNAME/PASSWORD to <origin>? [y/N]`. Only after a yes does it run `authenticated` (MCP `initialize` and `tools/list` with the two credential variables). Each line is `pass`, `FAIL` or `skip`. No line holds a credential or a header.
5. It names each missing credential variable and how to set it.
6. It asks before it writes the file. It keeps every other key of an existing config.

Without a terminal: `okknow setup --origin <url> --yes`. With `--yes`, setup sends the credentials only with `--probe-auth`, and it refuses an origin that differs from the saved origin unless `--replace-origin` is given. `--no-probe` sends no request. `okknow setup --check` prints the state of the origin (from `--origin`, `OKKNOW_ORIGIN` or the config) in words: the origin, `reachable`, `MCP`, and whether the credentials are set or missing. It sends no credential and writes nothing; `--no-probe` limits it to the form. On a server host, `--volume <dir>` records the content directory of the server; see [Server host](#server-host).

## Tool names

| Harness | List tools | Call a tool |
|---|---|---|
| Claude Code | `/mcp`, or the deferred tool list | `mcp__okknow__exec`, `mcp__okknow__write`, ... |
| Pi | `mcp({ server: "okknow" })` | `mcp({ tool: "okknow_exec", args: { command: "ls projects" } })` |
| Shell | `okknow tools` | `okknow call <tool> '<json>'` |

Common MCP calls:

| Task | Call |
|---|---|
| List a folder | `exec { command: "ls projects/demo" }` |
| Read a page with context | `exec { command: "cat projects/demo/brief.md" }` (adds frontmatter, backlinks, history) |
| Search | `search { query: "...", limit: 10 }` |
| Create or replace | `write { document: { path, content, position: "replace" }, summary }` |
| Append | `write { document: { path, content, position: "append" }, summary }` |
| Small change | `edit { document: { path, find, replace }, summary }` |
| Frontmatter change | `edit { document: { path, frontmatter: { key: value } }, summary }` |
| Delete | `delete { document: "<doc>" }` |
| Upload a file | `write { asset: { path: "images/x.png", content: "<base64>" } }` |
| Check a folder | `audit { path: "projects/demo" }` |

## CLI

| Command | Effect |
|---|---|
| `okknow read <doc> [--context]` | Prints the exact page. `--context` uses MCP `exec cat` and adds backlinks and history. |
| `okknow ls [dir]` | Lists a folder. |
| `okknow search <query> [--limit N]` | Ranked search. |
| `okknow write <doc> <file or -> --summary <text> [--append or --prepend or --replace]` | Refuses to overwrite an existing page without `--replace`. Refuses a new page without frontmatter `type`. Refuses content that contains the password. Saves the old page to `~/.cache/okknow/backups/` before a replace. |
| `okknow rm <doc> --yes` | Deletes a page. |
| `okknow asset put <file> <dest> [--summary <text>]` | Uploads a file of at most 8 MiB. |
| `okknow tools`, `okknow call <tool> '<json>'` | Raw MCP access. |
| `okknow doctor` | Checks the credentials, `/mcp`, the server version and the 401 without credentials. On a server host, also that no other OK process uses the content directory. |
| `okknow setup`, `okknow setup --check`, `okknow origin` | The wizard; the state of the origin without credentials; the configured origin. |
| `--json` (before the command) | JSON output. |

Exit codes: 0 success, 1 tool error or not found, 2 refused before any network request, 3 network or authentication error, 4 no origin configured. A reader that closes the pipe early (`okknow read <doc> | head`) ends the command quietly with exit 0.

`okknow --json doctor` adds a `state` word for a status line: `connected`, `no-credentials`, `unreachable`, `auth-failed`, `error`, `refused` or `not-configured`. The ops footer of the kit reads it.

The CLI talks only to the configured origin. It refuses another origin from `--origin` or `OPENKNOWLEDGE_ORIGIN`, refuses redirects, and ignores proxy variables.

## Install with the kit

`install.sh --with okknow` (see the module guide of the kit):

| Item | Location |
|---|---|
| Skill | The package `packages/okknow` of the kit clone, a `packages` entry of the Pi profile |
| Claude Code skill | `~/.claude/skills/okknow`, a link into the clone, when `~/.claude` exists |
| CLI | `~/.local/bin/okknow`, a link to `scripts/okknow` of this skill |
| User config | Written by `okknow setup`, which the installer runs |
| Pi MCP | With the `mcp` module: the server `okknow` in `<profile>/mcp-adapter.json`, header `Authorization: !<home>/.local/bin/okknow auth-header`, lazy |

The header command form `!<command>` is the one of pi-mcp-adapter 7.0.0 (the kit pin): the adapter runs the command in a shell at connect time, with a 10-second limit, and uses its trimmed standard output as the header value. `!!` starts a literal value.

`okknow auth-header` and the Pi adapter: Claude Code sets `CLAUDE_CODE_MCP_SERVER_URL` for a header helper, and `auth-header` refuses a URL that is not under the configured origin. pi-mcp-adapter sets no such variable, so for Pi the only rule is that standard output is not a terminal. Any process of the user that runs `okknow auth-header` into a pipe gets the header. That process already has the two credential variables in its environment, so it gets nothing new. The header is always for the configured origin: `auth-header` reads no origin from its caller.

Claude Code MCP is a separate step of the user. The header helper runs the CLI with the credentials of the Claude Code process:

```sh
claude mcp add-json -s user okknow "{\"type\":\"http\",\"url\":\"$(okknow origin)/mcp\",\"headersHelper\":\"$HOME/.local/bin/okknow --json auth-header\"}"
```

## Server host

A server host runs the OK server and has its content directory on disk. Record that directory once: `okknow setup --origin <url> --volume <dir>`. Then:

- `okknow doctor` also checks the `server.lock` file and that no other OK process uses the directory (Linux only).
- The CLI refuses a document name that is a path in that directory.
- `scripts/okknow-guard` blocks an agent write into that directory. It reads a hook payload on standard input and exits 2 to block. Wire it as a Claude Code `PreToolUse` hook for `Bash`, `Write` and `Edit`. Without the `volume` entry it allows every call.

A client, such as a laptop, has no `volume` entry and needs none of this.

## Scoped Pi launches

A Pi launch with `--no-extensions`, `--no-skills`, or its own `--mcp-config` does not load `okknow`. Add the MCP adapter extension, an MCP config with the server `okknow`, and `--skill <clone>/packages/okknow/skills/okknow` to a scoped launch that must use OK. The `--tools` list must contain `mcp`; add `bash` only if the agent needs the CLI.

Do not give `okknow` to an agent that reads untrusted web pages. A prompt injection could copy private pages to a web request. Give that agent a report file path; the parent writes the report to OK.

## Troubleshooting

| Symptom | Action |
|---|---|
| Exit 4, `no OpenKnowledge origin is configured` | Run `okknow setup`. |
| `OKKNOW_ORIGIN differs from the origin` | Unset `OKKNOW_ORIGIN`, or run `okknow setup` with the new origin. |
| `missing credentials` | Export the two variables in the startup file of the shell, then start a new shell. |
| `401` | The server refused the credentials. Check the two variables. |
| `okknow: command not found` | Run `~/.local/bin/okknow`, or put `~/.local/bin` on `PATH`. The kit launcher of a profile with the module adds it. |
| `refused: ... has the origin ...` from `setup --yes` | The config has another origin. Add `--replace-origin` to replace it, or run `okknow setup` in a terminal. |
| MCP `okknow` missing in Pi | `mcp({ connect: "okknow" })`, then `/mcp-adapter reconnect okknow`. |
| MCP `okknow` missing in Claude Code | `claude mcp get okknow`. The header helper needs the two credential variables in the Claude Code process environment. |
| `Concurrent overwrite refused` | Wait the stated seconds, read again, retry. The CLI retries once if the page did not change. |
