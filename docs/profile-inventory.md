# Profile inventory, names only

Status: offline implementation. `scripts/profile_inventory.py` is a pure module. The `inventory` action of `scripts/tenant_pi.py` reads one file, lists three directories, and writes nothing. No install, login, network request, or process start exists in it.

## Purpose

The user measures the parity gap between a kit candidate and an unmanaged live profile. `inventory` prints the resource names of one profile directory. Run it once for each directory and compare the two outputs by hand or with a text diff tool. The kit has no action that compares two inventories.

```sh
python3 scripts/tenant_pi.py inventory --dir '/home/example/.pi/agent'
python3 scripts/tenant_pi.py inventory --dir '/owned/parent/candidate a'
```

## Difference from `compare`

`compare` never lists a directory. `inventory` lists exactly three directories: `<dir>/extensions`, `<dir>/skills`, and `<dir>/prompts`. It lists only their direct entries and does not enter a subdirectory.

## What `inventory` reads

`--dir` is one absolute path that the user names explicitly. It follows the absolute-path rule of the kit: no `.` or `..` segment, and only the characters that `scripts/validate.py` accepts in a path.

| Path | Operation | Absent |
| --- | --- | --- |
| `<dir>/settings.json` | Opened and parsed through the bounded no-follow loader of `compare` (regular file, 1 MiB maximum, 64 nesting levels maximum, unique JSON keys). Only the `packages` key is used. | `settings_missing` error |
| `<dir>/extensions`, `<dir>/skills`, `<dir>/prompts` | Opened as a directory without following a symlink. The direct entries are listed: name and kind. No entry is opened. | Empty list |
| `<dir>/.tenant-pi/state.json` | The `.tenant-pi` directory is opened without following a symlink and is not listed. The marker gets one status check without following a symlink. The marker is not opened. | `managed: false` |

Two more paths get one status check each, and only when `settings.json` declares the part. No file is opened for them.

| Path | When | Result |
| --- | --- | --- |
| `<local package>/skills/herdr/SKILL.md` | A local package entry has `skills/herdr` in its `skills` filter. The path follows symlinks, as Pi does when it loads the package. | `coordination.herdrSkill`: `readable` or `not_readable` |
| `<dir>/npm/node_modules/@juicesharp/rpiv-ask-user-question/package.json` | A package entry names the npm package of the question extension. | `coordination.questionExtension`: `installed` or `declared` |

Without such an entry the value is `not_declared` and no path is checked. The three other keys of `coordination` are fixed: `herdrCli` is `not_checked`, `herdrSession` is `not_run`, and `questionUi` is `unverified`. `inventory` cannot measure them. See [Herdr and the question tool](herdr-setup.md#verification-results).

`auth.json`, `mcp.json`, `models.json`, `.tenant-pi/choices.json`, sessions, memory stores, the content of each skill, extension and prompt, and every other file stay unopened. The tests prove this with an audit hook that records each file open and each directory listing of the process, while private canary files sit beside the resources.

Every path component is opened as a real directory. A symlink in any component of `--dir`, a symlinked resource directory, and a symlinked `.tenant-pi` stop the action.

## Report

The output is one JSON object on one line, with sorted keys and fixed separators. Two runs on unchanged input produce identical bytes.

| Key | Content |
| --- | --- |
| `dir` | The given path. |
| `managed` | `true` when `<dir>/.tenant-pi/state.json` exists as a regular file. The value does not say that the candidate is complete; `compare` reads the status. |
| `packages` | One entry for each `settings.packages` item, in the order of the file. |
| `extensions`, `skills`, `prompts` | One `{ "name", "kind" }` entry for each direct entry, sorted by name. |
| `coordination` | Separate results for the Herdr skill and the question extension; see below. |
| `summary` | The counts of the four lists. |

A package entry has these forms:

| Settings item | Entry |
| --- | --- |
| A string | `{ "source": "<string>" }` |
| An object with a string `source` | `{ "source": "<string>", "filters": [<sorted names of the other keys>] }`. The filter values are never shown. |
| A source string outside the shown forms | `status: "unsupported_value"` replaces `source`. The string is not shown. |
| Any other shape | `{ "status": "unsupported_shape" }` |

A source string is shown only when it has one of these forms. The rule is an allowlist: every other string is `unsupported_value`.

| Shown form | Rule |
| --- | --- |
| Absolute POSIX path | The absolute-path rule of the kit: each segment uses `A-Za-z0-9_.-`, the space and the two quote characters, and is not `.` or `..`. |
| `npm:<name>` | An npm name with an optional scope and an optional exact `@X.Y.Z` version, as `scripts/validate.py` defines it. A tag or a range is not shown. |
| `https://` or `ssh://` URL, with an optional `git:` prefix | Host, optional numeric port, and a path of `A-Za-z0-9._~/-`. |
| `git:<host>/<path>` or `git:<host>:<path>` | The same host and path characters. |

In the two repository forms, the only login is the exact text `git@` before the host, and the only other `@` is a 40-hex commit pin at the end. This is the pin form that `generate` writes. No shown form has a `?`, `#` or `;`, an `@` in another position, whitespace outside a path segment, or an ASCII or C1 control character (below `0x20`, or `0x7f` to `0x9f`). A source of more than 1024 characters or an empty source is not shown.

`kind` is `file`, `dir`, or `symlink`. A symlinked entry is reported as `symlink` with its name only. The target is never read, resolved, or printed, and a dangling symlink has the same output. An entry that is none of the three, for example a FIFO or a socket, has the kind `other`.

No other settings value reaches the output. The report does not show `defaultModel`, `npmCommand`, `deviceId`, or an unknown key.

## Diagnostics

Each failure is one JSON object on stderr, with exit status 2 and an empty stdout: `{"candidate_created": false, "error": "<rule>: <field>"}`. The `error` text is static; no value appears in it. The `candidate_created` key is the common failure shape of the CLI. It is always `false` here, because `inventory` creates nothing. The table lists the main rules, among others that the loader can emit.

| Rule | Cause |
| --- | --- |
| `absolute_path: inventory.dir` | `--dir` is relative or has a segment that the path rule refuses. |
| `settings_missing: inventory.dir` | `<dir>` or `<dir>/settings.json` does not exist. |
| `input_path_unsafe: inventory.dir.settings.json` | A symlink or a non-directory in a path component. |
| `invalid_json: inventory.dir.settings.json`, and the other loader rules of `docs/generator.md` ("Input file errors") | JSON that the loader refuses. `invalid_json` adds `line` and `column`. |
| `input_not_regular: inventory.dir.settings.json` | `settings.json` is a symlink, a FIFO, or a directory. |
| `input_too_large: inventory.dir.settings.json` | `settings.json` is larger than 1 MiB. |
| `number: inventory.dir.settings.json` | The JSON text has `NaN` or an infinity constant. |
| `duplicate_key: JSON object` | An object in the JSON text repeats a key. |
| `object: inventory.dir.settings.json` | The JSON text is not an object. |
| `array: inventory.dir.settings.json.packages` | `packages` is present and is not an array. |
| `read_or_json: inventory.dir.<name>` | The resource directory `<name>` is a symlink or a file, or the listing fails. |
| `input_too_large: inventory.dir.<name>` | The resource directory has more than 4096 direct entries. |
| `read_or_json: inventory.dir.state.json` | `.tenant-pi` is a symlink or a file. |
| `input_not_regular: inventory.dir.state.json` | The marker exists and is not a regular file, for example a symlink or a directory. |

## Limits

- The action does not compare two inventories, read `mcp.json`, or write a file.
- A package source is a declaration. The action does not check that the package is installed or that a local path exists.
- Pi can load resources from other places, for example a project `.agents/skills` directory or a package. The action lists only the three directories of the named profile.
- The entry names of a directory are shown as the file system returns them. A name is not a secret by the rules of this kit; do not put a secret in a file name.

## Test coverage

`tests/test_profile_inventory.py` covers each shown source form, each hidden source form, sorting and byte-identical repeat output, each diagnostic, an unmanaged profile with only `settings.json`, entry kinds, symlinked and dangling entries, a symlink in a path component, unsafe resource and marker shapes, and the entry bound. Its audit hook records each open, each listing and each process start (`subprocess.Popen`, `os.exec`, `os.posix_spawn`, `os.system`, `os.fork`) inside the test process, and the test asserts that no process start occurs. `tests/test_cli.py` runs the action on an unmanaged profile and on a generated candidate in a disposable HOME, with private canary files, the same audit events with an allowlist of opened names, blocked sockets and subprocesses, and a source and fixture inventory check before and after.

Not verified:

- A run against a real live profile on a host. The fixtures are synthetic.
- A run on macOS or on another Unix. The tests ran on Linux only.
- That a shown source holds no credential. The allowlist closes the login, query, fragment and port positions. A token written as a host name, a path segment, or an npm package name has an allowed form and prints. Read the `packages` list of a profile before you share an inventory.
- Filter key names print unscreened. A key of the object form that is named like a secret prints as written. Only the values of the filters are hidden.
- Entry kinds on a file system that does not report the entry type in the directory listing. The code then uses a status call without following a symlink; no test covers that file system.
