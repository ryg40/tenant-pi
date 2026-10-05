# Runtime version check

Status: offline implementation, not a qualified runtime. The `check-runtime` action of `scripts/tenant_pi.py` replaces the manual version comparison of Stage 0 and Stage 3 in `INSTALL.md` with one deterministic command. The logic is in `scripts/check_runtime.py`.

This is the first and only action of the kit that starts a process. `validate`, `plan`, `generate` and `compare` start none. `scripts/check_runtime.py` is therefore not a pure module, unlike the other modules under `scripts/`.

## Command

```sh
python3 scripts/tenant_pi.py check-runtime
python3 scripts/tenant_pi.py check-runtime --pi /opt/pin/bin/pi --node /usr/local/bin/node --python /usr/bin/python3
```

| Option | Default | Rule |
| --- | --- | --- |
| `--pi <path>` | `pi` on `PATH` | Absolute path, else `absolute_path: check-runtime.pi` |
| `--node <path>` | `node` on `PATH` | Absolute path, else `absolute_path: check-runtime.node` |
| `--python <path>` | `python3` on `PATH` | Absolute path, else `absolute_path: check-runtime.python` |
| `--manifest <path>` | `config/manifest.json` of the kit | The same bounded no-follow loader and the same strict manifest validation as the other actions |

## What it runs

Exactly three commands, one for each tool that is found, in this order:

| Tool | Command | Environment |
| --- | --- | --- |
| Pi | `<pi> --version` | The environment of the caller, with `PI_CODING_AGENT_DIR` replaced by an empty temporary directory |
| Node | `<node> --version` | The environment of the caller, unchanged |
| Python | `<python3> --version` | The environment of the caller, unchanged |

- Each command is an argument list of an absolute path and `--version`. No shell runs. Standard input is `/dev/null`.
- Each command has a timeout of 20 seconds.
- No other command runs: no `npm`, no `git`, no install, no login, no network request.
- A tool that is not found on `PATH` starts no process, so at most three processes start.
- The action creates the temporary directory with `tempfile.mkdtemp` (prefix `tenant-pi-check-runtime-`, mode `0700`, under `TMPDIR`). It removes the directory and its contents after the Pi command, also when the command fails. This is the only write of the action. When the removal fails, the action stops with `cleanup_failed: check-runtime.tmpdir` and exit code 2, prints no report, and starts no further process. The directory then stays under `TMPDIR`; the diagnostic does not print its path. The action does not handle a signal: a `SIGTERM` or `SIGKILL` during the Pi command also leaves the directory.
- The lookup on `PATH` reads the `PATH` value. The child processes inherit the environment, because a Node version manager needs it. The action does not print or store an environment value.
- The action does not read `auth.json`, `models.json`, a session, a memory store or a `settings.json`. It does not edit the manifest pin.

## Comparison

The requirement of each tool comes from `manifest.runtime`:

| Tool | Field | Rule |
| --- | --- | --- |
| Pi | `piVersion` | The installed version text is equal to the pin. `1.0.3-beta.1` does not match `1.0.3`. |
| Node | `nodeRange` | The version numbers are inside the range. |
| Python | `pythonRange` | The version numbers are inside the range. |

The range grammar is the minimal grammar that the manifest uses, and nothing more:

- `>=a.b.c <d`: lower bound included, upper bound excluded. Example: `>=22.22.0 <23`.
- `>=a.b`: lower bound only. Example: `>=3.11`.

The lower bound has two or three numbers. The upper bound has one to three numbers. A number that is not given is 0. Another form fails with `runtime_range` before a process starts. The manifest validator accepts only the two reviewed range texts today, so a different range fails earlier with `runtime_range: manifest.runtime`.

A range comparison uses the first three numbers of the version. One exception: a prerelease of the lower bound itself is before the bound, so `22.22.0-rc.1` and `3.11.0a1` are `mismatch`. A prerelease above the lower bound, such as `3.14.0rc1`, is inside the range. A build suffix (`+...`) does not change the result.

The version is the first line of standard output, or of standard error when standard output is empty. Only the first 256 bytes count. Accepted forms: `1.0.0`, `v22.22.0`, `Python 3.11.2`: an optional name of one word, an optional `v`, then the version token. The token is two or three numbers, then an optional prerelease (`-` and characters from `0-9A-Za-z.-`, or lower-case letters and digits such as `rc1`), then an optional build (`+` and characters from `0-9A-Za-z.-`). The token has 40 characters maximum. Other text after the numbers, or a longer token, is `unparsed`.

## Pin record

The pin is `1.0.3` in `runtime.piVersion`, the `core` npm spec, and the reviewed constant in `scripts/validate.py`.
See [the changes in Pi 1.0.3](#the-changes-in-pi-103). `tests/test_check_runtime.py` holds `1.0.3` as `match`, and `1.0.2`, `1.0.0` and `0.99.2` as `mismatch`.

A matching runtime report removes the Pi version gap and marks the Pi install line `not_needed`. It does not prove a launch.

Not verified: an install of Pi `1.0.3` by the Stage 6 command on a clean client.
Not verified: an interactive launch of a generated profile with Pi `1.0.3` and the pin `1.0.3`, and a launch with a module.

### What the install command fixes

The command `npm install --global -- @earendil-works/pi-coding-agent@1.0.3` fixes the version of the Pi package only. From Pi 1.0.1, the published package has no `npm-shrinkwrap.json` (Pi changelog 1.0.1). So npm does not fix the versions of the transitive dependencies. The `@earendil-works/*` dependencies of Pi 1.0.3 have the range `^1.0.3`. A later install can then get a newer `pi-ai` or `pi-tui` below `2.0.0`. Two installs of the same pin on different dates can thus hold different dependency versions. `check-runtime` compares only the version of the Pi package and does not see this difference. The Pi changelog names the pi.dev installer as the install that fixes all dependencies. The kit does not use it.

Not verified: an install of the pin that gets a dependency version other than `1.0.3`.

### The changes in Pi 1.0.3

Sources: `CHANGELOG.md` of the package `@earendil-works/pi-coding-agent@1.0.3`, and a file comparison of the packages `1.0.2` and `1.0.3`.

The changelog marks one change as breaking. Three more changes touch a built-in extension, the key bindings or the MCP code of Pi. No change touches a skill.

| Change | Changelog section | Touches | Effect on the kit |
| --- | --- | --- | --- |
| The provider `azure-openai-responses` has the new name `azure` (Pi pull request 9714). | Breaking Changes | `settings.json` (`defaultProvider`, `enabledModels`, `modelThinkingLevels`), `models.json`, `auth.json`, and the type `KnownProvider` that an extension can import from `pi-ai` | See the text below the table. |
| Output files are readable only by the user: the full text of a truncated tool output, a binary MCP resource and a codemode image. | Changed | The built-in MCP extension (`dist/extensions/mcp/tools.js`) and the built-in tools | No effect on a kit file. Pi writes these files to the temporary directory of the system, not to the agent directory. |
| `Home` and `End` always move the editor cursor. `Ctrl+Home` and `Ctrl+End` go to the top and the bottom of the transcript. | Changed | The default keys of four key binding IDs in `pi-tui`: `tui.editor.cursorLineStart`, `tui.editor.cursorLineEnd`, `tui.altScreen.top` and `tui.altScreen.bottom` | The kit generates no `keybindings.json`. `packages/promptr` holds its own `pi-tui` 1.0.2 with the old default keys; see [the Promptr matrix](workflow-modules.md#promptr-unverified-with-a-readiness-matrix). |
| The codemode function `image()` also saves each image to a temporary file. A correction keeps codemode in operation after an update removed the running install. | New Features, Changed, Fixed | The built-in codemode extension | No effect on a kit file. |

The provider name: the changelog tells the user to change the name in `auth.json` (or to run `/login` again), in `models.json` and in the three keys of `settings.json`. The kit writes these three keys from `roles` and `modelRoutes.cycle` of the overlay. It takes each provider name from the overlay. It compares the name with the `--registry` file of the user, not with the provider list of Pi. The kit holds no such list. So an overlay and a registry file that name `azure-openai-responses` must name `azure` for Pi `1.0.3`. No tracked file of the kit names this provider. The `AZURE_OPENAI_*` variables did not change.

The other entries of the changelog touch no extension, no skill, no settings key and no MCP code: the Azure Foundry Chat Completions deployments, and two corrections (an OAuth token refresh after a cancelled request, and a crash report when the terminal goes away).

The file comparison agrees with the changelog:

- These files are byte-equal in `1.0.2` and `1.0.3`: `docs/settings.md`, `docs/extensions.md`, `docs/skills.md`, `docs/packages.md`, `docs/mcp.md`, `docs/environment-variables.md`, `dist/core/package-manager.js`, `dist/core/resource-loader.js`, `dist/core/settings-manager.js` and `dist/extensions/mcp/config.js`. So each source citation of [the resources page](resources.md) and of `packages/tenantext/extensions/resources/writers.ts` has the same line number in both versions.
- The package `@earendil-works/pi-mcp` `1.0.3` differs from `1.0.2` only in `package.json` and `CHANGELOG.md`.
- The `mcp` module of the kit is the npm package `pi-mcp-adapter`. It is not a part of a Pi release. Not verified: `pi-mcp-adapter` on Pi `1.0.3`.

Not verified: how Pi `1.0.3` treats a `settings.json` that still names `azure-openai-responses`. The changelog says only that a session of the old provider falls back to another model.

## Output

One JSON object on standard output, with sorted keys and fixed separators. The same installed tools give the same bytes.

```json
{"node":{"installed":"22.22.0","required":">=22.22.0 <23","status":"match"},"pi":{"installed":"1.0.2","required":"1.0.3","status":"mismatch"},"python":{"installed":"3.11.2","required":">=3.11","status":"match"}}
```

| Status | Meaning | `installed` |
| --- | --- | --- |
| `match` | The version satisfies the requirement. | The version |
| `mismatch` | The version is readable and does not satisfy the requirement. | The version |
| `missing` | The system cannot find or may not start the executable: not on `PATH`, the named path does not exist, it has no execute permission, or it is a script whose interpreter (the `#!` line) does not exist. | `null` |
| `unparsed` | The command ran or started and gave no usable version: unknown output, exit code other than 0, timeout, or a file that the system cannot execute. | `null` |

`installed` holds only a version token of the grammar above (40 characters maximum). Other output of a command never appears in the result or in an error. The prerelease and build parts of a token are text from the command, inside that grammar and that bound.

| Exit code | Meaning |
| --- | --- |
| 0 | All three tools are `match`. |
| 1 | One or more tools have another status. The JSON object is still on standard output. |
| 2 | Bad input, or a failed removal of the temporary directory. Standard error has `{"candidate_created": false, "error": "<rule>: <field>"}`. Bad input starts no process. |

Exit code 0 means only that three version numbers agree with the manifest. It is not a runtime qualification.

### The report as input of `plan` and `generate`

`plan` and `generate` do not run this action. Without its report they print `node_runtime_unverified` and `core_runtime_unverified`. To give them the measured versions, write the report to a file and name the file with `--runtime-report`:

```sh
python3 scripts/tenant_pi.py check-runtime > /path/to/runtime.json
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --runtime-report /path/to/runtime.json
```

A `match` then removes the gap of that tool. Another status gives a gap that names the installed and the required version, for example `core_runtime_mismatch`. The `python` entry adds no gap. The file must be the unchanged report of this kit version: `plan` and `generate` refuse a report whose `required` values differ from `manifest.runtime`. See [the plan](profile-plan.md#readiness-after-measured-facts).

## Limits

- The action checks the tools that the current shell finds. The shell that launches Pi later can find other tools. Run the action in that shell.
- The action does not check `npm` or Git.
- The action does not install or change a version. A `mismatch` is a decision for the user; see Stage 3 of `INSTALL.md`.

## Test coverage

`tests/test_check_runtime.py` covers:

- The range grammar and its bounds, the version output forms, the 40 character bound, a free-text suffix (`unparsed`, not echoed), and a prerelease of the lower bound (`mismatch`).
- Each status with an injected runner: the three exact argument lists, no shell, the 20 second timeout, the replaced `PI_CODING_AGENT_DIR`, and removal of the directory when the runner fails. A patched `rmtree` that raises gives `cleanup_failed: check-runtime.tmpdir`, and exit code 2 through the CLI. One test runs a real fake `pi` that sleeps 3 seconds with the timeout set to 1 second: the result is `unparsed` and the directory is gone.
- The real action in a disposable HOME with fake `pi`, `node` and `python3` executables on `PATH`, for `match`, `mismatch`, `missing` and `unparsed`. The fake `pi` records that its directory is empty and is not the live directory, then writes a file into it; the test proves that the directory is gone after the run.
- No other process: an audit hook records every process-creation event of the CLI process (`subprocess.Popen`, `os.system`, `os.exec`, `os.spawn`, `os.posix_spawn`, `os.fork`, `os.forkpty`, `pty.spawn`). The test accepts only the three expected executables. Decoy `npm`, `git`, `sh`, `curl`, `env` and `which` commands on `PATH` stay unused. Sockets are blocked.
- No read of the canary files `auth.json`, `models.json`, `settings.json` and `sessions` by the CLI process (file-open audit; this is a list of forbidden names, not a proof that no other file is opened, and the audit does not see the child processes). No canary text in the output, an unchanged manifest, and static diagnostics for a relative path, a missing manifest, a symlink manifest and a changed range.

Not verified: that `pi --version` with `PI_CODING_AGENT_DIR` set writes nothing outside that directory and opens no network connection. The kit sets the variable and removes the directory; the behaviour of Pi is not measured.
Not verified: the output form of `pi --version` on versions other than `1.0.0`, `1.0.2` and `1.0.3`, and behaviour on macOS, with a Node version manager shim, or with a `python3` older than 3.4 (which prints its version on standard error).
Not verified: that a child process of a tool stops at the timeout. The timeout stops the tool itself.
Not verified: a real failed removal of the temporary directory. The tests force it with a patched `rmtree`.
