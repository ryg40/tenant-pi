# Private directory

Status: offline implementation, not a qualified runtime. The `init-private` action of `scripts/tenant_pi.py` creates the private directory of one host in one fixed shape. The private directory holds the overlay, the registry, the install log and the accepted-drift list; see [the profile lifecycle](profile-lifecycle.md). The logic is in `scripts/private_init.py`. It uses the ancestor walk and the file creation of the guarded writer of `generate` (`scripts/profile_write.py`).

## Command

```sh
python3 scripts/tenant_pi.py init-private --dir /home/EXAMPLE_USER/.config/tenant-pi --target /home/EXAMPLE_USER/.pi/profiles/main
```

| Option | Rule |
| --- | --- |
| `--dir <path>` | Required. An absolute POSIX path of a directory that does not exist. Its parent exists. 1024 characters maximum. |
| `--target <path>` | Optional. The absolute POSIX path of the new profile directory. The new `overlay.json` gets it as `target.agentDir`. See "The target option" below for its rules. |
| `--overlay <file>` | Optional, repeatable. An overlay file whose `target.agentDir` the directory must stay outside of. The bounded no-follow loader reads it; the action uses only `target.agentDir`. |

The overlay-target refusal covers three things only: the sample target of `config/config.example.json`, the path of `--target`, and the `target.agentDir` of each `--overlay` file that the caller names. The action does not search for overlays. Without `--overlay` and without `--target`, no real overlay target is checked. The `--overlay` option is the way the action learns the target of another overlay.

The action reads `HOME` to find `~/.pi/agent` and `~/.llm-wiki`. It reads `WIKI_HOME` to find the wiki vault of that root. It reads no other environment value. `HOME` must be set and must be an absolute path without a trailing slash.

## What it creates

| Path | Kind | Mode | Content |
| --- | --- | --- | --- |
| `<dir>` | directory | `0700` | |
| `<dir>/overlay.json` | file | `0600` | A copy of `config/config.example.json`, byte for byte. With `--target`: the same text with another value of `target.agentDir` |
| `<dir>/registry.json` | file | `0600` | `{}` (from `config/private/registry.json`) |
| `<dir>/install-log.md` | file | `0600` | From `config/private/install-log.md` |
| `<dir>/accepted-drift.md` | file | `0600` | From `config/private/accepted-drift.md` |
| `<dir>/.gitignore` | file | `0600` | From `config/private/gitignore` |
| `<dir>/inputs` | directory | `0700` | Empty. It holds the fixed `overlay.inputs` slots, for example `inputs/mcp-adapter.json` |

An install adds more files to the directory later, and `init-private` creates none of them: the saved runtime report, each launcher file, each baseline file, the facts file `results-facts.json` and the results file `INSTALLER_KIT_RESULTS.md`. See [the results file](install-results.md).

The templates are tracked text files of the kit. The action copies each template without a change. Without `--target` it does not edit the overlay copy: the target of the copy is the fake sample target `/home/EXAMPLE_USER/new-agent`, and the user must change it. `validate`, `plan` and `generate` refuse an overlay with the sample target; see "The target option".

The `.gitignore` template ignores these names: `inputs/`, `.env`, `.env.*`, `auth.json`, `models.json`, `mcp-adapter.json`, `sessions/`, `*.key`, `*.pem`, `*.db`, `*.sqlite`, `*baseline*.json`, `INSTALLER_KIT_RESULTS.md`, `results-facts.json`. It has no negation line (`!`). It does not ignore `overlay.json`, `registry.json`, `install-log.md` or `accepted-drift.md`: these four files are the record that a second host or a recovery starts from.

Warning: the `.gitignore` file is not a security control. A secret in a file with another name is not ignored. Read `git status` before each commit, and do not write a secret value into the overlay, the registry or the two Markdown files.

## The target option

With `--target <path>`, the action parses the overlay template, replaces the one value `target.agentDir` and writes the result in the form of `scripts/examples.py`: two spaces of indent and the key order of the template. Exactly one line of `overlay.json` differs from `config/config.example.json`. A core-only profile then needs no edit: `init-private`, `validate`, `plan` and `generate` run one after the other.

The path rules, all before any write:

- The path has the form of each absolute path of the kit: no `.` or `..` segment, no trailing `/`, no shell or template character. It is an expanded path. The action does not expand `~` or `$HOME`; the shell does that for `"$HOME/..."` in double quotes.
- The path has 1024 characters maximum, and it is not the sample target.
- The path is not `~/.pi/agent`, the live agent directory, and is not under it.
- The path is not `--dir` and is not under it. `--dir` is not the path and is not under it.
- The path is not the kit clone and is not under it.

For the last three rules the path counts twice: as written, and with its symbolic links resolved (this reads link targets only, no file content). The order is: the form of the target, then the rules of `--dir`, then the location of the target.

The action does not open or create the target. It does not check that the target is absent or that its parent exists: `generate` checks both.

The sample target has its own rule in the other actions. `validate`, `plan` and `generate` refuse an overlay whose `target.agentDir` is `/home/EXAMPLE_USER/new-agent` with `sample_target: overlay.target.agentDir` and exit code 2. An overlay from a run without `--target` gives this result until the user changes the value. To change it by hand, change the one value of the key `target.agentDir`, then check the syntax with `python3 -m json.tool <dir>/overlay.json >/dev/null` before `validate`.

## Output

One JSON object on standard output, with sorted keys and fixed separators. The same directory path and the same kit location give the same bytes.

```json
{"commands":{"editDisplayOnly":"${EDITOR:-vi} /home/EXAMPLE_USER/.config/tenant-pi/overlay.json","gitInitDisplayOnly":"git init /home/EXAMPLE_USER/.config/tenant-pi","validateDisplayOnly":"python3 /home/EXAMPLE_USER/tenant-pi/scripts/tenant_pi.py validate --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --local-dir /home/EXAMPLE_USER/.config/tenant-pi"},"complete":true,"created":[{"kind":"directory","mode":"0700","path":"/home/EXAMPLE_USER/.config/tenant-pi"}],"directory":"/home/EXAMPLE_USER/.config/tenant-pi","warnings":[]}
```

The example shows one `created` entry; the real list has seven entries: the directory, `inputs`, then the five files in sorted order. The example is the output without `--target`.

- `created`: each created path as an absolute path, with its mode and kind.
- `commands.editDisplayOnly` and `commands.validateDisplayOnly`: the two commands that the user runs next. Edit the overlay, then validate it.
- `commands.gitInitDisplayOnly`: the `git init` line for the directory. It is display text. The action does not run Git and creates no `.git` directory.
- `warnings`: empty, or `cleanup_failed: init-private.descriptors` when the close of a directory descriptor fails after the last file is written. The tree is complete in that case.
- `targetAgentDir`: only with `--target`. The path that the new overlay holds as `target.agentDir`. Without `--target` the output has no such key.

The three command lines are display text; the action starts no process. Each path in a command line is quoted for a POSIX shell. The only caller text in the output is the `--dir` path and, with `--target`, the target path. The character class of each is the class of an absolute kit path (letters, digits, `_`, `.`, space, `-`, and the two quote characters) and the length of each is 1024 characters maximum. The `editDisplayOnly` line contains the literal text `${EDITOR:-vi}`; the action does not read `EDITOR`.

| Exit code | Meaning |
| --- | --- |
| 0 | The tree is complete. |
| 2 | A refusal or a failed write. Standard error has `{"candidate_created": <bool>, "error": "<rule>: <field>"}`. `candidate_created` is `true` when the directory exists after the failure. With the rule `invalid_json`, the object also has the integers `line` and `column`. |

## Refusals

Each refusal is a static `rule: field` text. It contains no path and no value. The loader rules of an `--overlay` file and of a template name one cause each; see `docs/generator.md`, "Input file errors".

| Diagnostic | Cause | Filesystem change |
| --- | --- | --- |
| `absolute_path: init-private.dir`, `text: init-private.dir`, `shell_or_template: init-private.dir` | The path is not an absolute POSIX path of the kit form. | None |
| `path_too_long: init-private.dir` | The path has more than 1024 characters. | None |
| `under_kit: init-private.dir` | The path is the kit clone or is under it. This includes `.local/` of the clone. | None |
| `under_pi_agent: init-private.dir` | The path is `~/.pi/agent` or is under it. | None |
| `under_wiki_vault: init-private.dir` | The path is `~/.llm-wiki` or is under it. With `WIKI_HOME` set, also `<WIKI_HOME>/.llm-wiki`. | None |
| `under_overlay_target: init-private.dir` | The path is the `target.agentDir` of an overlay or is under it. The overlays are `config/config.example.json`, each `--overlay` file, and the new overlay with the path of `--target`. | None |
| `absolute_path: init-private.target`, `text: init-private.target`, `shell_or_template: init-private.target` | The `--target` path is not an absolute POSIX path of the kit form. A path that starts with `~` gives `absolute_path`; a path with `$` gives `shell_or_template`. | None |
| `path_too_long: init-private.target` | The `--target` path has more than 1024 characters. | None |
| `sample_target: init-private.target` | The `--target` path is the sample target of `config/config.example.json`. | None |
| `under_private_dir: init-private.target` | The `--target` path is under `--dir`. | None |
| `under_kit: init-private.target` | The `--target` path is the kit clone or is under it. | None |
| `under_pi_agent: init-private.target` | The `--target` path is `~/.pi/agent` or is under it. | None |
| `under_wiki_vault: init-private.target` | The `--target` path is `~/.llm-wiki` or is under it. With `WIKI_HOME` set, also `<WIKI_HOME>/.llm-wiki`. | None |
| `target_exists: init-private.dir` | The path exists: a directory (also an empty one), a file, a link or another entry. | None |
| `parent_missing: init-private.dir.parent` | The parent, or a directory above it, does not exist. The action does not create a parent. | None |
| `unsafe_parent_owner: init-private.dir.parent` | The parent is owned by root and the caller is not root. | None |
| `unsafe_owner: init-private.dir.parents` | The parent or a directory above it is owned by a user that is not root and not the caller. | None |
| `unsafe_permissions: init-private.dir.parents` | The parent or a directory above it is writable by group or others and has no sticky bit. | None |
| `unsafe_path: init-private.dir.parents` | The parent or a directory above it is a symbolic link or is not a directory. | None |
| `home_required: init-private.home`, `absolute_path: init-private.home` | `HOME` is not set or is not an absolute path. | None |
| `input_missing`, `input_path_unsafe`, `input_unreadable`, `input_not_regular`, `input_too_large`, `input_encoding`, `invalid_json`, `input_too_deep`, `text` or `absolute_path` with the field `init-private.overlay` | An `--overlay` file is not a readable regular JSON file inside the loader bounds, or it has no absolute `target.agentDir`. | None |
| `input_path: init-private.overlay` | The `--overlay` path has a `.` or `..` segment or a NUL character. | None |
| `number: init-private.overlay` | The `--overlay` file has `NaN`, `Infinity` or `-Infinity`. | None |
| `duplicate_key: JSON object` | The `--overlay` file, or the overlay template, has an object with the same key twice. This shared rule of the kit names no `init-private` field. | None |
| `input_missing`, `input_path_unsafe`, `input_unreadable`, `input_not_regular`, `input_too_large`, `input_encoding`, `invalid_json`, `input_too_deep`, `number`, `text` or `absolute_path` with the field `init-private.template.<file name>` | A template of the kit is missing, is not a regular file, is larger than 1 MiB, or the overlay template is not JSON with an absolute `target.agentDir`. | None |
| `fields: init-private.templates` | Module use only: `init()` gets a mapping that is not exactly the five file names with bytes values. The CLI always builds the correct mapping. | None |
| `dir_privacy: init-private.dir`, `dir_privacy: init-private.dir.inputs`, `file_privacy: init-private.dir.files` | A created entry does not have the mode `0700` or `0600` or the owner of the caller, for example because of a restrictive umask. | The directory stays, incomplete |
| `write_failed: init-private.dir`, `short_write: init-private.dir.files`, `target_changed: init-private.dir` | A write fails after the directory is created, or another process replaces the directory. | The directory stays, incomplete |
| `target_unavailable: init-private.dir` | The creation of the directory itself fails. | None |

The four location rules of `--dir` (`under_kit`, `under_pi_agent`, `under_wiki_vault`, `under_overlay_target`) compare path text before any other access. The four location rules of `--target` (`under_private_dir`, `under_kit`, `under_pi_agent`, `under_wiki_vault`) run after them and work in the same way; the target path also counts with its symbolic links resolved. Each forbidden root counts twice: as written, and with its symbolic links resolved (this reads link targets only, no file content). The ancestor walk then refuses each symbolic link above the new directory, so a link cannot reach a forbidden root from another name.

The action has no rollback. After a failure with `"candidate_created": true`, inspect the directory and remove it yourself; a second run refuses it with `target_exists`.

## What it does not do

- It runs no Git command and no other process, and it opens no network connection.
- It does not read `auth.json`, `models.json`, a session, a memory store or a `settings.json`. It reads the five templates, each `--overlay` file, and the metadata of the directories above `--dir`. With `--target` it also resolves the symbolic links of the target path; it opens no file there.
- It does not edit a live profile, a shell startup file or a file of the kit. Without `--target` it does not edit the overlay copy; with `--target` it changes the one value `target.agentDir` of the copy.
- It does not create or open the target directory.
- It writes no secret value. The templates contain none.
- It does not create the parent directory and does not adopt an existing directory.

## Limits

`under_kit` covers only the root of the kit that runs the action. A second clone of the kit, the main clone when the action runs from a Git worktree, and a worktree when the action runs from the main clone are not protected: the action can create the directory there, for example in `.local/` of that other clone.

`under_overlay_target` covers only the sample overlay, the path of `--target` and the named `--overlay` files; see "Command".

`under_pi_agent` knows only `~/.pi/agent`. The action reads no `PI_CODING_AGENT_DIR`, so a live agent directory that only this variable names is not refused as a `--target`. `generate` refuses each target that exists. `validate`, `plan` and `generate` apply the same rule to `target.agentDir`, with the same limit; see `docs/generator.md`.

`sample_target` is the one path `/home/EXAMPLE_USER/new-agent`. Another path with the placeholder user name `EXAMPLE_USER`, for example a path that was copied from a document, passes the rule.

The boundary is the Linux-first boundary of the guarded writer; see [the guarded writer](profile-write.md). It does not protect against another process of the same user, against root, or against a filesystem that ignores permissions. The path comparison does not detect a forbidden root that a bind mount or a hard-linked directory shows under another name.

## Test coverage

`tests/test_private_init.py` covers:

- The created tree under umask `000`: the exact seven entries, the modes `0700` and `0600`, each file equal to its template byte for byte, an empty `inputs`, and no `.git`.
- The template set: the five names, the `{}` registry, the ignored names of the `.gitignore` template, and no negation line.
- Each refusal: an existing directory, file, link, dangling link and FIFO; an absent parent; a parent that the caller does not own; a linked, a non-directory and a writable ancestor; each path form; a path under the kit clone, under `~/.pi/agent` (also when `~/.pi/agent` is a link), under the sample overlay target and under the target of a named overlay; a bad `--overlay` file (unreadable, linked, without a target, a `.` or `..` path segment, `NaN` and `Infinity`, a duplicate key); a missing `HOME`, a relative `HOME` and a `HOME` with a trailing slash.
- A damaged kit template, with the CLI in the test process and the kit root moved to a disposable copy: a missing template, a linked one, a FIFO, one larger than 1 MiB, and an overlay template that is not JSON or has no target. Each gives a static `init-private.template.<file name>` diagnostic and creates nothing.
- That the location rules stop before the ancestor walk, and that a refusal creates nothing and leaves an existing entry unchanged.
- Failures after creation: a restrictive umask, an `inputs` directory with a wrong mode (`dir_privacy: init-private.dir.inputs`), a failed file write, a replaced directory, a failed close before completion (the primary error stays) and after completion (a static warning in the report; the test asserts the call order: five files, then three closes).
- The real CLI in a disposable `HOME`: deterministic output equal to the report of the module, `created` equal to the tree on disk, no process start (an audit hook records `subprocess.Popen`, `os.system`, `os.exec`, `os.spawn`, `os.posix_spawn`, `os.fork`, `os.forkpty` and `pty.spawn`; decoy `git`, `vi` and `sh` commands on `PATH` stay unused), no open of the canary files `auth.json`, `models.json` and `settings.json`, no canary text in the output, and the printed `validate` line on the unedited copy stops with `sample_target: overlay.target.agentDir`.
- The `--target` option: the overlay bytes (one changed line, the key order of the template, a path with quote characters), the report with `targetAgentDir`, and the report without the option (no such key). With the real CLI and no edit of any file: `init-private --target`, the printed `validate` line, `plan` and `generate` succeed, start no process and open no file of the live profile.
- Each `--target` refusal, with nothing created: a relative path, a `~` path, a `$HOME` path, a path that is too long, the sample target, `~/.pi/agent` and a path under it (also through a link), a path under the kit clone (also through a link), a path under `--dir` (also through a link), and a `--dir` that is the target or is under it. A bad `--dir` is reported before a bad target location. An existing target and a target with an absent parent pass, and the action does not create or change them.
- `tests/test_cli.py`: `validate`, `plan` and `generate` refuse the tracked example with `sample_target: overlay.target.agentDir` and change nothing; another path of the same form passes; an invalid overlay is reported first; direct `scripts/validate.py` accepts the example.
- `tests/test_cli.py`: `validate`, `plan` and `generate` refuse a `target.agentDir` that is `~/.pi/agent` or is under it with `under_pi_agent: overlay.target.agentDir` and change nothing, also through a link; a target beside the directory passes.

Not verified: behaviour on macOS or on a filesystem other than a local Linux filesystem.
Not verified: the refusal `unsafe_parent_owner` with a real non-root caller under a root-owned parent. The test changes the caller identity with a patch; a second test, which runs only as root, gives the parent to another user and gets `unsafe_owner`.
Not verified: `dir_privacy: init-private.dir.inputs` through a real fault. The test changes the mode of `inputs` inside a patched `mkdir`.
Not verified: `duplicate_key: JSON object` and `number` in a kit template. The tests cover both rules on an `--overlay` file; the template path uses the same parser.
Not verified: `file_privacy`, `short_write` and `target_unavailable` through a real filesystem fault. `write_failed` and `target_unavailable` are forced with a patch; `file_privacy` and `short_write` come from the shared file creation of the guarded writer and have no test of their own here.
Not verified: that `git init` and a later commit in the created directory track exactly the four record files. The kit runs no Git command, and no test runs Git against the template.
Not verified: that the ignored names cover every file of a host that can hold a secret. The list is a fixed set of names, not a scan.
Not verified: the open-audit is a list of forbidden names, not a proof that no other file is opened.
