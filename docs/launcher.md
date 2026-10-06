# Launcher file

Status: offline implementation, not a qualified runtime. The `--launcher` option of `plan` and `generate` in `scripts/tenant_pi.py` gives one profile one launcher file. The file holds the exact launch line of the plan, so the user does not copy the line by hand and does not run the wrong `PI_CODING_AGENT_DIR`; see [the profile lifecycle](profile-lifecycle.md). The logic is in `scripts/launcher.py`. It uses the ancestor walk and the file creation of the guarded writer of `generate` (`scripts/profile_write.py`).

## Command

```sh
python3 scripts/tenant_pi.py plan --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --launcher /home/EXAMPLE_USER/.config/tenant-pi/launch-main.sh
python3 scripts/tenant_pi.py generate --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --target /home/EXAMPLE_USER/.pi/profiles/main --launcher /home/EXAMPLE_USER/.config/tenant-pi/launch-main.sh
```

| Option | Rule |
| --- | --- |
| `--launcher <path>` | Optional, for `plan` and `generate`. An absolute POSIX path of a file that does not exist. Its parent exists and is owned by the caller. 1024 characters maximum. |

- `plan --launcher` prints the path as `commands.launcherDisplayOnly`. It applies the static location rules of the table "Refusals" and writes nothing. It does not check that the file is absent.
- `generate --launcher` applies the static rules and the ancestor and absence checks before it creates the target. It writes the launcher file only after the profile is complete (`filesComplete` is `true`). A failed generation writes no launcher file.
- Without `--launcher`, the output of `plan` and `generate` does not change.

With `--launcher`, the two actions read `HOME` to find `~/.pi/agent`, as `init-private` does. The launcher rules read no other environment value. `HOME` must be set and must be an absolute path without a trailing slash.

## The file

The file has mode `0700` and exactly two lines:

```sh
#!/bin/sh
exec env TENANTEXT_LITELLM_BASE_URL=https://gateway.example.invalid/v1 env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve
```

The second line is `exec env `, then the `commands.launchDisplayOnly` line of the plan byte for byte, then a newline. The example shows a gateway profile; a core-only profile has only `env -u PI_CODING_AGENT_SESSION_DIR` and the `PI_CODING_AGENT_DIR` assignment.

- `env` is necessary. A POSIX shell refuses `exec NAME=value command`, because `exec` takes a command, not an assignment. `env` sets the assignments of the line for the one `pi` process, as the shell does when the user types the line.
- `exec` replaces the shell with `pi`. No shell process stays.
- The line holds a second `env`, with `-u PI_CODING_AGENT_SESSION_DIR`. It removes that variable for the one `pi` process; see "The session directory" below. The file has `env` two times because the file and the typed line hold the same text.
- When the gateway is enabled, the line holds the `TENANTEXT_LITELLM_BASE_URL` assignment. The URL is public configuration, not a key.
- The file holds no API key and no other secret value. `TENANTEXT_LITELLM_API_KEY` reaches `pi` only from the environment of the shell that runs the file. Export it in that shell, or start the file from a secret store you already use.
- The file passes no arguments: it does not contain `"$@"`. To give Pi an argument, run the plan line by hand.
- `pi` and `env` are found on the `PATH` of the shell that runs the file, as for the typed line.

Run the file with its path, for example `/home/EXAMPLE_USER/.config/tenant-pi/launch-main.sh`. A recommended place is the private directory of [init-private](private-directory.md); the kit does not enforce it. The file name is free.

## The session directory

Rule: a generated profile keeps its sessions in `<target>/sessions`. The launch line removes an inherited `PI_CODING_AGENT_SESSION_DIR` with `env -u PI_CODING_AGENT_SESSION_DIR`. The kit edits no shell startup file to do this.

Why the rule is necessary: a login shell can export `PI_CODING_AGENT_SESSION_DIR` (for example, a script in `/etc/profile.d` can do this). Pi then writes the sessions of every profile to that directory, not to `<target>/sessions`.

These facts come from the documents and the source of Pi 1.0.2 (`@earendil-works/pi-coding-agent`). The kit pin is `runtime.piVersion` in `config/manifest.json`.
A comparison with Pi 1.0.3 found each cited document and source file byte-equal, with one exception.
`dist/config.js` has changes, and its function `getAgentDir` has none. The `dist/` files of the two versions read the same set of environment variable names.

- Precedence: `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` field of `settings.json`, then the default (`docs/cli.md`, `docs/sessions.md`, `docs/settings.md`; `dist/main.js` lines 548 to 551).
- The default is `<agent dir>/sessions/--<working directory>--/`: one directory for each working directory (`dist/core/session-manager.js`, `getDefaultSessionDirPath`). The agent directory is the value of `PI_CODING_AGENT_DIR` (`dist/config.js`, `getAgentDir`).
- A directory from `--session-dir`, from the variable or from `sessionDir` is used as given. Pi makes no directory for each working directory in it, and filters the files by working directory when it reads them.

Why the line removes the variable and does not set a directory:

- Without the variable, Pi uses its documented default. The sessions have the same layout as in a shell that never had the variable. A value of `<target>/sessions`, as a variable or as `--session-dir`, changes the layout to a flat directory.
- An extension that reads the variable sees the same state. Hermes reads `PI_CODING_AGENT_SESSION_DIR` for `/memory-index-sessions`; see [the memory modules](memory-modules.md).
- The line does not hold the target path a second time. The quoting of a target with a space or a quote character stays in one place.
- An empty assignment (`PI_CODING_AGENT_SESSION_DIR=`) also gives the default in Pi 1.0.2, but only because the source tests the value for truth. No Pi document states it, so the kit does not use it.

`env -u` is in GNU coreutils. Not verified: BusyBox, the BSDs and macOS. POSIX.1-2018 does not list the option; not verified: POSIX.1-2024. The launch line has the form `[assignments] env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=<quoted target> pi --no-approve`.

Pi variables and settings that move a state path out of the agent directory, from Pi 1.0.2 (`docs/environment-variables.md` and a search of `dist/` for `process.env`):

| Name | What it moves | State |
| --- | --- | --- |
| `PI_CODING_AGENT_DIR` | The agent directory: settings, auth, sessions, packages, the debug log. | Handled. The launch line sets it to the target. |
| `PI_CODING_AGENT_SESSION_DIR` | The session files. | Handled. The launch line removes it. |
| `--session-dir` | The session files. It wins over the variable. | Handled. The launch line does not hold it. The launcher file passes no argument. |
| `sessionDir` in `<target>/settings.json` | The session files. | Handled for the generated file: the kit writes no `sessionDir` key. Not handled after a user or a Pi command adds the key. |
| `sessionDir` in a project `.pi/settings.json` | The session files. Pi 1.0.2 merges the project file over the global file (`dist/core/settings-manager.js`). Not verified: the effect of project trust. | Not handled. The kit does not read a project directory. |
| `PI_TUI_WRITE_LOG` | A log of the terminal output, at the given file or directory (`pi-tui`, `dist/terminal.js`). Not in the Pi documents. | Not handled. A debug variable; the user sets it on purpose. |
| `PI_TUI_DEBUG` | Render logs in `/tmp/tui` when the value is `1` (`pi-tui`, `dist/tui-main-screen.js`). Not in the Pi documents. | Not handled. A debug variable. |
| `PI_TUI_DEBUG_REDRAW` | A redraw log `pi-tui-debug.log` when the value is `1` (`pi-tui`, `dist/tui-main-screen.js`). Pi 1.0.2 gives the agent directory as the log directory, so the file stays in the target. Not in the Pi documents. | No action necessary. A debug variable. |
| `PI_PACKAGE_DIR` | Where Pi reads its own package files (themes, export template). Pi writes no state there. | Not handled. Read-only for Pi. |
| `PI_MANAGED_INSTALL_ROOT` | The root of a managed Pi install, for the self-update (`dist/package-manager-cli.js`). | Not handled. The kit installs Pi with npm, not as a managed install. |
| `HOME`, `TMPDIR` | Not Pi variables. With `PI_CODING_AGENT_DIR` set, `HOME` does not move the agent directory. Pi and its extensions can read other paths under `HOME`. | Not handled. |

The other names of the Pi 1.0.2 table (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `PI_SHARE_VIEWER_URL`, `PI_RADIUS_GATEWAY`, the terminal names) hold no path. An installed extension can read its own variables; `WIKI_HOME` is one, see [the memory modules](memory-modules.md).

The dependency lines of the plan (`commands.setupDisplayOnly`: `pi update --extensions`, the peer override) set `PI_CODING_AGENT_DIR` only. Not verified: that `pi update --extensions` writes no session file.

## Print mode

Stage 9 check 3 of `INSTALL.md` needs one reply of the model. The launch line takes Pi options after it, so `-p '<prompt>'` after the plan line gives the print mode of Pi for the generated profile:

```sh
env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve -p 'What is 17 plus 26? Reply with the number only.'
```

The launcher file passes no argument, so it cannot do this. Type the plan line.

These facts come from the documents of Pi 1.0.2 (`docs/cli-integration.md`, `docs/cli.md`):

- Print mode runs the given prompts, writes the final assistant text to standard output, and exits. It does not show the events between.
- Print mode writes errors to standard error. A final reply with the stop reason `error` or `aborted` gives an exit status that is not 0.
- Extensions load in print mode too (`docs/extensions.md`).

Observed with Pi 1.0.2 on Linux: print mode sends only the final reply to standard output.
Thinking text stays in the session file under `<target>/sessions`. A connection error gives exit status 1.
Observed separately with Pi 1.0.3: the same results with no provider key and these environment settings:
`PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`.
Both observations cover a generated core-only profile and a loopback test endpoint, not a live provider.

Rule: Pi reads a provider key from the environment of the launching shell, including in a profile with no login.
The launch line and the launcher file do not clear such a variable. The model reply check names the model with `--model '<provider>/<model>'`.
The `plan` action warns when a known provider key variable is set; see [the warning](profile-plan.md#the-warning-for-a-provider-key-variable).
Not verified: which variable names Pi reads for each provider. Use the name that the Pi documentation gives.

Not verified: print mode after a `/login` of a native provider, where the credential is in `<target>/auth.json`.
Not verified: print mode with the gateway route, with an in-tree extension, or with the `mcp`, `hermes` or `wiki` module.
Not verified: print mode on that observed release without the three `PI_*` variables above, and with a provider key in the environment.
Not verified: print mode on macOS, and from a shell without a terminal.

## Output

`plan` and `generate` print one JSON object with sorted keys and fixed separators. `--launcher` adds the key `commands.launcherDisplayOnly`, the path as given. `plan` adds the key `commands.providerKeyWarning` when a known provider key variable is set in the shell of the plan run; see [the warning](profile-plan.md#the-warning-for-a-provider-key-variable). `generate` also adds a `launcher` object:

```json
{"complete":true,"fileCreated":true,"mode":"0700","path":"/home/EXAMPLE_USER/.config/tenant-pi/launch-main.sh","warnings":[]}
```

- `complete`: `true` when the file is written and checked.
- `fileCreated`: `true` when a file exists at the path after this run.
- `warnings`: empty, or `cleanup_failed: launcher.descriptors` when the close of the parent descriptor fails after the file is complete.
- After a failure: `{"complete":false,"error":"<rule>: launcher.path","fileCreated":<bool>,"path":"<path>"}`.

The only caller text in the output is the `--launcher` path. Its character class is the class of an absolute kit path (letters, digits, `_`, `.`, space, `-`, and the two quote characters) and its length is 1024 characters maximum. The file content is the plan line, which the kit builds from validated values only. The module refuses a line that is not one line of printable ASCII (`launch_line: launcher.content`).

| Exit code | Meaning |
| --- | --- |
| 0 | The profile is complete. With `--launcher`, the launcher file is complete too. |
| 1 | `generate` only: the profile is complete, but the launcher file is not. Standard output has the full report; `launcher.error` names the rule. Standard error is empty. |
| 2 | A refusal or a failed generation. Standard error has `{"candidate_created": <bool>, "error": "<rule>: <field>"}`. No launcher file is written. |

## Refusals

Each refusal is a static `rule: field` text. It contains no path and no value. All refusals of this table fire before any write: no target and no launcher file is created.

| Diagnostic | Cause |
| --- | --- |
| `absolute_path: launcher.path`, `text: launcher.path`, `shell_or_template: launcher.path` | The path is not an absolute POSIX path of the kit form. This includes a relative path. |
| `path_too_long: launcher.path` | The path has more than 1024 characters. |
| `under_target: launcher.path` | The path is the target or is under it. The target is `target.agentDir` of the overlay and, for `generate`, `--target`. |
| `under_pi_agent: launcher.path` | The path is `~/.pi/agent` or is under it. |
| `under_kit: launcher.path` | The path is the kit clone or is under it. This includes `.local/` of the clone. |
| `target_exists: launcher.path` | `generate` only. The path exists: a file, a directory, a link, a dangling link or another entry. |
| `parent_missing: launcher.path.parent` | `generate` only. The parent, or a directory above it, does not exist. The kit does not create a parent. |
| `unsafe_parent_owner: launcher.path.parent` | `generate` only. The parent is owned by root and the caller is not root. |
| `unsafe_owner: launcher.path.parents` | `generate` only. The parent or a directory above it is owned by a user that is not root and not the caller. |
| `unsafe_permissions: launcher.path.parents` | `generate` only. The parent or a directory above it is writable by group or others and has no sticky bit. |
| `unsafe_path: launcher.path.parents` | `generate` only. The parent or a directory above it is a symbolic link or is not a directory. |
| `home_required: launcher.home`, `absolute_path: launcher.home` | `HOME` is not set or is not an absolute path. |

The three location rules (`under_target`, `under_pi_agent`, `under_kit`) compare path text. Each root counts twice: as written, and with its symbolic links resolved (this reads link targets only, no file content). The ancestor walk then refuses each symbolic link above the file, so a link cannot reach a root from another name. The path cannot start with `!`, `+` or `-` and cannot have a leading or trailing slash or a `.` or `..` segment: the absolute-path rule allows only `/` as the first character.

These failures come after a complete generation. `generate` returns exit code 1 with the full report and the diagnostic under `launcher`:

| Diagnostic under `launcher.error` | Cause | `fileCreated` |
| --- | --- | --- |
| `target_exists: launcher.path` | An entry appeared at the path after the check before the generation. The entry is not changed. | `false` |
| `file_privacy: launcher.path` | The created file does not have the mode `0700` or the owner of the caller, for example because of a restrictive umask. The file stays. | `true` |
| `short_write: launcher.path`, `write_failed: launcher.path`, `target_changed: launcher.path` | A write fails after the file is created, or another process replaces the file. The file stays. | `true` |
| `target_unavailable: launcher.path` | The creation of the file itself fails. | `false` |
| `cleanup_failed: launcher.descriptors` | The close of the parent descriptor fails before the file is complete. | as found |
| An ancestor rule of the table above | A parent changed during the generation. | `false` |

The kit has no rollback. After a failure with `"fileCreated": true`, inspect the file and remove it yourself. The profile stays complete: run `generate` with a new target, or write the plan line by hand.

## What it does not do

- It edits no shell startup file and changes no `PATH`.
- It does not run the launcher file, Pi or any other process, and it opens no network connection.
- It writes no secret value. It does not read `auth.json`, `models.json`, a session or a memory store.
- It does not replace or adopt an existing file. A new profile needs a new launcher path, or the user removes the old file first.

## Limits

`under_kit` covers only the root of the kit that runs the action. A second clone of the kit, or the main clone when the action runs from a Git worktree, is not protected.

The boundary is the Linux-first boundary of the guarded writer; see [the guarded writer](profile-write.md). It does not protect against another process of the same user, against root, or against a filesystem that ignores permissions. The path comparison does not detect a root that a bind mount or a hard-linked directory shows under another name.

## Test coverage

`tests/test_launcher.py` covers:

- The text: the shebang and `exec env ` plus the line, and the refusal of an empty line, a newline, a NUL, non-ASCII text and a non-string value.
- The file from the real CLI in a disposable `HOME` with a gateway profile and a target name with a space and quote characters: the bytes of the file equal `#!/bin/sh`, then `exec env ` plus `commands.launchDisplayOnly` of the `plan` output and of the `generate` output; mode `0700`; the gateway URL is in the line; no key name and no key value is in the file or the output. A core-only profile gives the same form.
- The session directory (`test_inherited_session_dir_does_not_reach_pi`): with a target name that has a space and the two quote characters, the plan line and the file hold `env -u PI_CODING_AGENT_SESSION_DIR` before the `PI_CODING_AGENT_DIR` assignment. In an environment that exports `PI_CODING_AGENT_SESSION_DIR` and another `PI_CODING_AGENT_DIR`, a recording `pi` gets the target as `PI_CODING_AGENT_DIR` and no `PI_CODING_AGENT_SESSION_DIR`, from `/bin/sh -c '<plan line>'` and from the file. Another variable of the caller stays. `tests/test_profile_plan.py` checks the form for a target with a quote character.
- That the file runs the same command as the plan line: a recording `pi` on `PATH` gets the same arguments and the same full environment (a sorted `env` dump, which holds `PI_CODING_AGENT_DIR`, `TENANTEXT_LITELLM_BASE_URL` and the key) from `/bin/sh -c '<plan line>'` and from the file. The key comes from the environment of the caller.
- `plan --launcher`: the path under `commands`, no file and no target written; the refusal of a relative path and of a path under the target, the kit clone and `~/.pi/agent`. Without `--launcher`, no new key.
- Each refusal from the CLI, with no target, no launcher and no other change in the test directory: an existing file, a relative path, a path equal to and under the target, a path under the kit clone (also `.local/`), a path under `~/.pi/agent` (also when `~/.pi/agent` is a link), an absent parent, a linked ancestor, a path that is too long, and a missing or relative `HOME`. A failed generation (an existing target, `pi_login_blocked`) writes no launcher.
- In the module: an existing file, directory, link, dangling link and FIFO; an absent parent, a linked and a non-directory ancestor, a writable ancestor, and a parent that the caller does not own; a restrictive umask (`file_privacy`, the file stays with mode `0500`); an entry that appears after the ancestor walk; a failed creation and a failed write; a failed close before completion (the primary error stays) and after completion (a static warning).
- After a complete generation: a failed creation, a short write and an entry that appears during the generation each give exit code 1, the full report with `filesComplete: true`, and the static diagnostic under `launcher`.

Not verified: behaviour on macOS, on a shell other than `dash` as `/bin/sh`, or on a filesystem other than a local Linux filesystem.
Not verified: that Pi never reads the launcher path, so that no Pi trim rule applies to it. The kit gives the path to Pi in no file and no argument; no test runs Pi.
Not verified: a run of the file with a real Pi. The test uses a recording `pi` script.
Not verified: that a real Pi, started from a shell that exports `PI_CODING_AGENT_SESSION_DIR`, writes its sessions into `<target>/sessions`.
Not verified: `env -u` on macOS, the BSDs and BusyBox. The tests use GNU coreutils.
Not verified: `unsafe_parent_owner` with a real non-root caller under a root-owned parent. The test changes the caller identity with a patch.
Not verified: `file_privacy`, `short_write`, `write_failed`, `target_changed` and `target_unavailable` through a real filesystem fault. The tests force them with a patch or a umask; `target_changed` has no test.
Not verified: that `fileCreated` is right after a failure other than "exists" in every race. The module checks for an entry at the name after the failure; another process can create or remove one in between.
