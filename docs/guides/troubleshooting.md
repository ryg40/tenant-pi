# Troubleshooting

Each kit script prints a failure as one static line. This guide lists the known failure classes and the fix.

## How to read a diagnostic

`install.sh` prints a refusal as one line `install: <reason>` on standard error and exits with code 2. It writes nothing before a refusal. The reason names the variable or the path to correct.

A kit script with JSON output (`scripts/check_runtime.py`, `scripts/pi_update.py`) prints a refusal as one JSON object and exits with code 2:

```json
{"error": "absolute_path: check-runtime.pi"}
```

- The `error` text has the form `rule: field`. It never holds a path, a value or a secret.
- A refusal for a link in the path adds one key, `hint`. See [A link in the path](#a-link-in-the-path).
- `scripts/check_runtime.py` exits with 0 when Node and Python match, and Pi is `match` or `untested_in_range`. A failed requirement gives exit code 1. Its report is on standard output.

### A link in the path

A diagnostic with a `hint` key means that a directory of the path is a symbolic link. `scripts/pi_update.py` refuses a linked directory of its work directory. On macOS, `/tmp`, `/var` and `/etc` are such links, and `$TMPDIR` is under `/var`:

```json
{"error": "unsafe_path: pi-update.workdir", "hint": "/tmp is a link to private/tmp; give the resolved path /private/tmp/q"}
```

Give the resolved path of the hint, or a path under the home directory. Do not make a link to get past the refusal. `python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' <path>` prints the resolved form of a path on Linux and macOS.

## install.sh

- A refusal names the fix. A common case: `~` inside quotes is not expanded. Give the absolute path, such as `"$HOME/.pi/profiles/main"`.
- A line that starts with `kept:` is no failure. The file was there before, and the script never overwrites a file. When the script also prints a `note:` line, add `"<clone>/packages/tenantext"` to the `packages` list of that file.
- A line that starts with `skipped:` names a skill of your own with the same name in `~/.claude/skills`. Keep it, or move it and run the script again.

## Wiki embedding diagnostics

`/tenantext-doctor` reports wiki embedding settings without an embedding request. See [Switch wiki embeddings off](../memory-modules.md#switch-wiki-embeddings-off) for the diagnostics, the settings keys and the restart check.

## Runtime and environment

These failures come from the runtime or from the environment of the launching shell.

### `pi --version` opens the live profile

A bare `pi` command reads `~/.pi/agent`, or the directory in `PI_CODING_AGENT_DIR`. A version check can then touch the live profile.

1. Run `python3 scripts/check_runtime.py`. It sets `PI_CODING_AGENT_DIR` to an empty temporary directory for `pi --version` and removes the directory. `--launcher ~/.local/bin/<name>` checks the runtime of that launcher, for example Pi-Bolt.
2. Without the kit, run `PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version`.

### `PI_CODING_AGENT_DIR` points at the wrong profile

A shell that exports `PI_CODING_AGENT_DIR` changes every later `pi` command of that shell. The start line of [the first start](../../INSTALL.md#first-start) sets the variable for one process only.

1. Run `echo "${PI_CODING_AGENT_DIR:-<unset>}"` before a manual `pi` command.
2. Start a profile with the start line, or with a shell alias that holds it.

### `check_runtime.py` reports `mismatch` or `missing`

| Status | Fix |
| --- | --- |
| `untested_in_range` for `pi` | Keep the installed version and record it as untested. The kit tests ran on the tested version only. |
| `untested_in_range` for `pi` with `piBolt` in the report | The Pi-Bolt release carries the tested Pi version, but `piBolt.installed` is not `piBolt.tested` (`runtime.piBoltVersion`). Keep it and record it as untested, or install the tested Pi-Bolt release. |
| `missing` for `pi` | Install the pin with the line of [the prerequisites](../../INSTALL.md#prerequisites), or add its directory to `PATH` in the launching shell. |
| `mismatch` for `pi` | Keep the other Pi and record the gap, or install the manifest pin (`runtime.piVersion`) under a prefix. Do not run the global install line as a default step: it replaces the other Pi for every profile. Example: an installed Pi `0.99.2` is a `mismatch`. |
| `mismatch` for `node` | Select Node 24 with your version manager in the launching shell. |
| `unparsed` | Run the tool with `--version` by hand and read the output. |

### The key or the `PATH` line is missing in another shell

A non-interactive SSH command, a browser terminal, a desktop launcher or a service does not always read your interactive startup file. Run `python3 scripts/check_runtime.py` and `test -n "${TENANTEXT_LITELLM_API_KEY:-}" && echo set` in the shell that starts Pi.

### Pi warns about host-provided extension packages

Pi `0.99.x` and later print this warning at start:

```text
Warning: Extension package ".../package.json": Host-provided extension packages must be declared in
peerDependencies with a "*" range, not dependencies: typebox.
```

An installed package lists a host module under `dependencies`, and the override did not run after the install. One cause: a start of Pi installs a declared package that is missing, without the override. Then each start prints the warning until the override script runs. [Host peer overrides](../host-peer-overrides.md) names the package versions that were checked. Run the override by hand:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" node "$HOME/tenant-pi/scripts/patch_extension_peers.mjs"
```

The script prints one line for each manifest that it corrects, and nothing when no manifest needs a correction. The line names the script by its absolute path, so it runs from each directory.

An update of the package writes the old manifest again. See [host peer overrides](../host-peer-overrides.md) for the `npmCommand` wrapper.

### `pi install` prints `vulnerabilities` and a hint to run `npm audit fix`

The `pi install` line of the `wiki` package prints an audit summary of npm for the dependency tree of the package: a count of vulnerabilities, a hint to run `npm audit fix`, and an `npm warn install-scripts` line. This output is expected, and the install did not fail. The kit did not review these findings.

Warning: do not run `npm audit fix` in the profile, and do not run `npm audit fix --force`. The command changes the installed packages of the profile. It can undo the peer override, and it can install versions that the kit did not review.

To go without the module, run `pi remove npm:@zosmaai/pi-llm-wiki` with the `PI_CODING_AGENT_DIR` of the profile. See [the optional modules](../../INSTALL.md#optional-modules).

## Kit checks

### The publish check fails after pytest

`pytest` writes a `.pytest_cache/` directory into the clone. The publish check counts every file that is not in its reviewed inventory, so it fails:

```text
unreviewed_file: repository inventory
.pytest_cache/.gitignore
```

One path line follows the finding line for each such file. The sample shows the first.

1. Remove the cache directory: `rm -rf .pytest_cache`. Check the path before you run it.
2. Run the tests with `python3 scripts/check.py --tier fast`.

The same failure comes from any untracked file in the clone.

### The documentation check fails

`scripts/doc_check.py` checks the Markdown files of the publish set offline: relative links and anchors resolve, each fenced `json` block parses, and each environment name of `INSTALL.md`, `README.md` and a guide is a known name. It does not check the documents under `packages/`, and it does not prove that a command works. The unit tests run the same check, and the failure text holds each finding.

Run `PYTHONDONTWRITEBYTECODE=1 python3 scripts/doc_check.py` to see the findings alone. Each finding is one `rule: path:line` line with no text of the file. The docstring at the top of the script states the rules. `link_unpublished` means that the target is outside the publish set, so a portable snapshot does not hold it.

## When nothing here fits

1. Keep every directory as it is.
2. Write down the exact diagnostic and the command.
3. Read [INSTALL.md](../../INSTALL.md) and the document of the script: [Pi update checks](../pi-update.md), [in-tree packages](../packages.md).
