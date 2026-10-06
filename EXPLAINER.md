# EXPLAINER: what the install does, step by step

This document shows the install of one Pi profile as a usual README procedure. Each step has a short explanation, the command and the expected output. Below each step, collapsed blocks name each script, each function and each file that the step touches.

The reader is a developer who wants to know the footprint and the components. For other readers:

- An agent that installs a profile for a user reads [INSTALL.md](INSTALL.md).
- A user who wants the stages with all options reads [the setup guide](docs/guides/setup.md).
- For a failure, read [troubleshooting](docs/guides/troubleshooting.md). This document has little troubleshooting.

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [How to read this document](#how-to-read-this-document)
- The steps:
  1. [Look at the machine](#step-1-look-at-the-machine)
  2. [Clone the kit and run its checks](#step-2-clone-the-kit-and-run-its-checks)
  3. [Check the runtime versions](#step-3-check-the-runtime-versions)
  4. [Create the private directory](#step-4-create-the-private-directory)
  5. [Create the parent of the target](#step-5-create-the-parent-of-the-target)
  6. [Read the overlay](#step-6-read-the-overlay)
  7. [Validate](#step-7-validate)
  8. [Plan](#step-8-plan)
  9. [Generate](#step-9-generate)
  10. [Install the dependencies](#step-10-install-the-dependencies)
  11. [Decide how Pi gets a credential](#step-11-decide-how-pi-gets-a-credential)
  12. [Record the baseline of the live profile](#step-12-record-the-baseline-of-the-live-profile)
  13. [Launch the profile and log in](#step-13-launch-the-profile-and-log-in)
  14. [Run the checks](#step-14-run-the-checks)
  15. [Record the install](#step-15-record-the-install)
- [The footprint after a core-only install](#the-footprint-after-a-core-only-install)
- [Remove the install](#remove-the-install)
- [The components](#the-components)
- [What an optional module adds](#what-an-optional-module-adds)
- [Where the outputs come from](#where-the-outputs-come-from)

## What you get

- A new Pi profile directory, the **target**. The example is `~/.pi/profiles/main`. The kit writes its `settings.json` from your choices.
- A **private directory**, `~/.config/tenant-pi`. It holds your choices (the **overlay**), your records and a launcher file.
- Your existing Pi profile, the **live profile** `~/.pi/agent`, without a change. The kit refuses a target in it, and two kit actions show a change.

The kit is a generator, not an installer. It writes files into new directories only. It installs no package, starts no service, edits no shell startup file and stores no credential. You install Pi, log in and launch Pi yourself. See [the privacy guide](docs/guides/privacy.md#what-the-kit-never-does).

A **core-only** profile is Pi with no optional module. This document installs a core-only profile. [What an optional module adds](#what-an-optional-module-adds) shows the difference.

Status: Linux is the first target. The kit steps are tested offline. Not verified: a complete live run on a clean client; see the status line of [README.md](README.md).

## Requirements

| Item | Required | Notes |
| --- | --- | --- |
| Linux | the first target | macOS and Windows are not qualified; see [the release checklist](docs/guides/release-checklist.md#platforms-that-are-not-qualified). |
| Python | `>=3.11` | Standard library only. The kit has no Python dependency. |
| Node | `>=22.22.0 <23` | With npm. The same Node installs Pi. |
| Pi | `<pin>` | The npm package `@earendil-works/pi-coding-agent`. Step 10 installs it when it is missing. |
| Git | any current version | Only to clone the kit. |

This document writes `<pin>` for the exact Pi version that the kit requires. Read it from `config/manifest.json`, key `runtime.piVersion`.

| Name | Where to read it | Source |
| --- | --- | --- |
| `<pin>` | Read `runtime.piVersion` | `config/manifest.json`, key `runtime.piVersion` |

To read the three runtime requirements from your clone:

```sh
python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"])'
```

## Quick start

These commands make a core-only profile on Linux. Each command is one step below. Read the step before you run a command that you do not know.

```sh
git clone <kit repository URL> "$HOME/tenant-pi"
cd "$HOME/tenant-pi"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py

mkdir -p "$HOME/.config" "$HOME/.pi/profiles"
python3 scripts/tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/main"
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json"
python3 scripts/tenant_pi.py check-runtime > "$HOME/.config/tenant-pi/runtime.json"
python3 scripts/tenant_pi.py plan --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --launcher "$HOME/.config/tenant-pi/launch-main.sh" --runtime-report "$HOME/.config/tenant-pi/runtime.json"
python3 scripts/tenant_pi.py generate --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --target "$HOME/.pi/profiles/main" \
  --launcher "$HOME/.config/tenant-pi/launch-main.sh" --runtime-report "$HOME/.config/tenant-pi/runtime.json"

python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
"$HOME/.config/tenant-pi/launch-main.sh"
python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"
```

The last three commands are steps 12 to 14. The launcher starts Pi. Run `/login` inside Pi, then exit Pi before the last command.

These commands install no Pi and set no credential. Do step 10 first when `check-runtime` does not print `match` for `pi`. Do step 11 before the launch.

## How to read this document

**The paths.** The examples use these four paths. You can use other paths.

| Name | Example path | What it is |
| --- | --- | --- |
| The clone | `~/tenant-pi` | This repository on your machine. |
| The private directory | `~/.config/tenant-pi` | Your choices and records. Outside the clone. |
| The target | `~/.pi/profiles/main` | The new profile directory. The kit creates it in step 9. |
| The live profile | `~/.pi/agent` | The profile that a bare `pi` command opens when `PI_CODING_AGENT_DIR` is not set. The kit does not write into it. |

The kit takes absolute paths only and does not expand `~`. Write `"$HOME/..."` in double quotes in a command. The shell then expands it. A path segment can hold letters, digits, a space and the characters `_`, `.`, `-`, `'` and `"` only. A home directory with another character, for example `@`, stops `init-private` with `absolute_path: init-private.home`.

**The live profile.** `init-private --target`, `validate`, `plan` and `generate` refuse a target that is `~/.pi/agent` or is under it. The rule is `under_pi_agent`. The kit finds the directory from `HOME` and does not read `PI_CODING_AGENT_DIR`. So the refusal does not protect a live directory that only this variable names: choose a target outside that directory. Steps 12 and 14 show a change of the live profile.

**The outputs.** The output examples show the kit commands; see [where the outputs come from](#where-the-outputs-come-from). Three kinds of value are replaced:

- The home directory is `/home/you`.
- The Pi version of the release is `<pin>`.
- A count, a duration or a commit hash that changes with each release is a name in angle brackets, for example `<count>`.

**The JSON form.** Each kit action prints one JSON object on one line, with sorted keys. This document shows the object on more than one line. An output that is marked "shortened" leaves out keys; the drill-down names each key. To get a readable form on your machine, add `| python3 -m json.tool` to the command.

**The errors.** A refused action prints one JSON object on standard error and exits with code 2. The text has the form `rule: field`. It never holds a path or a value.

**The drill-down blocks.** Each step has blocks that you can open:

- "What runs" names the script and the functions, in call order.
- "Files" names each path that the step reads, creates or changes, with its mode, its content and its writer. The writer is the kit, Pi, npm, Git or you.
- "Output" gives the meaning of each output field.
- "Not touched" says what the step does not do.

## Step 1: look at the machine

You collect the facts about the machine before a change. You learn the versions of the tools and whether a live profile exists. The clone does not exist at this time, so these are shell commands and not a kit action.

```sh
uname -sm; node --version; npm --version; python3 --version; git --version
command -v pi && PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version
env | grep '^PI_CODING_AGENT_' || echo "no PI_CODING_AGENT_ variable"
for d in "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] || [ -L "$d" ]; then echo "live agent directory present: $d"; else echo "live agent directory absent: $d"; fi
done
```

Expected output, on a machine that has Pi and a live profile:

```text
Linux x86_64
v22.22.3
10.9.8
Python 3.11.2
git version 2.39.5
/usr/local/bin/pi
<pin>
no PI_CODING_AGENT_ variable
live agent directory present: /home/you/.pi/agent
```

Compare each version with [the requirements](#requirements). When `command -v pi` prints nothing, Pi is not installed: step 10 installs it.

<details><summary>What runs</summary>

No kit script runs. Each line is a shell command:

| Command | What it tells you |
| --- | --- |
| `uname -sm` | The operating system and the processor type. |
| `node --version`, `npm --version`, `python3 --version`, `git --version` | The installed versions. |
| `command -v pi` | The path of the `pi` command that the shell finds, or nothing. |
| `PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version` | The installed Pi version. |
| `env \| grep '^PI_CODING_AGENT_'` | Each Pi variable that the shell exports. |
| The `for` loop | One line for each live profile directory: `present` or `absent`. |

Pi reads its profile directory when it starts, also for `pi --version`. The variable `PI_CODING_AGENT_DIR` selects that directory for one Pi process. Without the variable, Pi opens the live profile `~/.pi/agent`. So the command gives Pi an empty temporary directory.

Two Pi variables change where a profile keeps its data. Record each one that the `env` line prints:

- `PI_CODING_AGENT_DIR` names another live profile. The loop then prints a second line for that directory.
- `PI_CODING_AGENT_SESSION_DIR` moves the sessions of each profile to one directory. The launch line of step 9 removes it for the new profile.

</details>

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| A new empty directory under `$TMPDIR` (default `/tmp`), from `mktemp -d` | created, mode `0700` | you |
| `$TMPDIR/node-compile-cache/` | created by the `pi --version` process when it is absent | Pi |
| `~/.pi/agent` | The loop tests that the name exists. It opens nothing. | none |

The temporary directory stays after the command. Observed with Pi 1.0.2: `pi --version` leaves an empty agent directory unchanged.

`node-compile-cache/` is the compile cache of Node. It stays after the command too. Observed with Pi 1.0.2 and Node 22.22.3. Not verified: other versions.

</details>

<details><summary>Not touched</summary>

- The live profile. That is the reason for the temporary directory.
- Each shell startup file. If a variable is set there, leave it. The kit works around it.
- The network, as far as the commands of this step go. Not verified: that `pi --version` opens no connection.

</details>

## Step 2: clone the kit and run its checks

You get the kit and prove that the clone is the reviewed kit. The two checks are offline. If one fails, stop: do not generate a profile from that clone.

```sh
git clone <kit repository URL> "$HOME/tenant-pi"
cd "$HOME/tenant-pi"
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
```

Expected output, after the lines of `git clone`:

```text
----------------------------------------------------------------------
Ran <count> tests in <seconds>s

OK (skipped=1)
publish set valid: <count> files, <count> explicit (not a release approval)
```

Run each later command of this document from the clone directory.

Warning: do not move or delete the clone after step 9. A profile with an in-tree module names a directory of the clone by its absolute path.

<details><summary>What runs</summary>

| Command | Script | What it does |
| --- | --- | --- |
| `git clone` | Git | Copies the repository into `~/tenant-pi`. |
| `python3 -m unittest discover -s tests -q` | each `tests/test_*.py` | Runs the unit tests of the kit. `tests/test_doc_check.py` also runs the documentation check of `scripts/doc_check.py`. |
| `python3 scripts/publish_check.py` | `check()` in `scripts/publish_check.py` | Proves that each file of the clone is in a reviewed list. |

`check()` does these things, in this order:

1. It lists each file of the clone. It leaves out `.git`, `.local`, `__pycache__` and `node_modules`.
2. `tracked_files()` runs `git rev-parse --show-toplevel` and `git ls-files` to get the tracked files.
3. It reads each file of the publish set and searches it for private-key and token patterns (`PATTERNS`).
4. It compares the file list with the reviewed inventory. A file that no list names stops the check with `unreviewed_file: repository inventory`.
5. It validates `config/manifest.json` and `config/config.example.json` with `manifest()` and `overlay()` of `scripts/validate.py`.
6. It compares `config/config.example.json` with the text that `render()` of `scripts/examples.py` makes from the manifest.

`PYTHONDONTWRITEBYTECODE=1` stops Python from writing `__pycache__` directories into the clone. Use `unittest`, not `pytest`: `pytest` writes a cache directory into the clone. No list names its files, so the publish check then fails.

On a machine with Node and Git, one test is skipped. As root, it is a test that needs a file that the user cannot read. As another user, it is a test that needs root.

</details>

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `~/tenant-pi/` | created | Git |
| Temporary directories under `$TMPDIR` | The tests create them for their fake home directories and fake profiles, and remove them. | the tests |
| Each file of the clone | read | none |

The checks use temporary directories and remove them. Use `git status --short` to check for changes in your clone.

The parts of the clone that the install uses:

| Path | What it is |
| --- | --- |
| `config/manifest.json` | The **manifest**: each component, its source pin, its status, and the runtime requirements. |
| `config/config.example.json` | The example overlay. Step 4 copies it. |
| `config/private/` | Four templates for the private directory. |
| `scripts/tenant_pi.py` | The command line of the kit. Each action of this document starts here. |
| `scripts/` | The modules behind the actions; see [the scripts](#the-scripts). |
| `packages/tenantext`, `packages/promptr` | The in-tree optional modules. A core-only profile does not use them. |
| `tests/`, `docs/` | The unit tests and the reference documents. |

</details>

<details><summary>Output</summary>

- `Ran <count> tests` and `OK`: each test passed.
- `publish set valid: <count> files, <count> explicit`: the first number is the size of the publish set. The second number is the length of the `PUBLISH` list in `scripts/publish_check.py`.
- `not a release approval`: the check proves the file lists and the patterns. It does not prove that a release is good.

</details>

<details><summary>Not touched</summary>

- Your home directory: the tests use disposable home directories.
- No package is installed. The kit has no dependency to install.

</details>

## Step 3: check the runtime versions

One kit action compares the installed Pi, Node and Python with the requirements of the manifest. It is the only kit action that starts a process. A status other than `match` is a finding for you to decide on, not a failure of the kit.

```sh
python3 scripts/tenant_pi.py check-runtime
```

Expected output:

```json
{"node":{"installed":"22.22.3","required":">=22.22.0 <23","status":"match"},"pi":{"installed":"<pin>","required":"<pin>","status":"match"},"python":{"installed":"3.11.2","required":">=3.11","status":"match"}}
```

The exit code is 0 when each status is `match`, and 1 when a status is not `match`. It is 2 for a refusal: bad input, or a temporary directory that the kit cannot remove.

<details><summary>What runs</summary>

In `scripts/tenant_pi.py`, `main()` does this for the action:

1. `_load_input()` reads `config/manifest.json` through the bounded loader: a regular file, 1 MiB maximum, no symbolic link in the path.
2. `manifest()` of `scripts/validate.py` checks the manifest against the reviewed values in the script.
3. `check()` of `scripts/check_runtime.py` finds `pi`, `node` and `python3` on `PATH` with `shutil.which`.
4. `_probe()` runs `<tool> --version` for each tool that it finds: no shell, no standard input, a timeout of 20 seconds. Each process gets the whole environment of your shell.
5. For Pi, `_probe_pi()` first makes an empty temporary directory and sets `PI_CODING_AGENT_DIR` to it for that one process. It removes the directory after the command.
6. `parse_version()` reads the version from the first output line.
7. The comparison: the Pi version must be equal to `runtime.piVersion` as text. The Node and Python versions must be in their range (`parse_range()`, `in_range()`).
8. `matches()` gives the exit code.

The options `--pi`, `--node` and `--python` take the absolute path of another executable.

</details>

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `config/manifest.json` | read | none |
| `$TMPDIR/tenant-pi-check-runtime-<random>/` | created with mode `0700`, then removed | the kit |
| `$TMPDIR/node-compile-cache/` | created by the `pi --version` process when it is absent; see step 1 | Pi |

The kit writes no other file. It removes its temporary directory after the action. `pi --version` can leave `node-compile-cache/` in `$TMPDIR`.

</details>

<details><summary>Output</summary>

The object has one entry for `pi`, `node` and `python`. Each entry has three keys:

| Key | Meaning |
| --- | --- |
| `installed` | The version that the tool printed, or `null`. |
| `required` | The requirement from `runtime` in the manifest. |
| `status` | `match`, `mismatch`, `missing` or `unparsed`. |

| `status` | Meaning |
| --- | --- |
| `match` | The version satisfies the requirement. |
| `mismatch` | The tool printed a version that does not satisfy the requirement. |
| `missing` | The shell does not find the tool, or cannot start it. |
| `unparsed` | The tool ran and gave no version that the kit can read. |

This is the report of a machine where another Pi version is installed. The run used a stand-in `pi` command, and `<installed>` is the version that it printed:

```json
{"node":{"installed":"22.22.3","required":">=22.22.0 <23","status":"match"},"pi":{"installed":"<installed>","required":"<pin>","status":"mismatch"},"python":{"installed":"3.11.2","required":">=3.11","status":"match"}}
```

With `mismatch` for Pi you have three choices: stop, keep the installed Pi and record the difference, or install `<pin>` under a separate directory. Step 10 has the commands. The kit never changes the installed Pi.

See [the runtime version check](docs/check-runtime.md) for the version grammar and each exit code.

</details>

<details><summary>Not touched</summary>

- The live profile: the Pi process gets the empty temporary directory.
- No install, no `npm`, no `git`, no network request from the kit.
- The action checks the tools of the current shell only. Another shell can find other tools. Run the action in the shell that will launch Pi.

</details>

## Step 4: create the private directory

The kit creates the directory that holds your choices and your records. With `--target`, the new overlay already names the target, so a core-only profile needs no edit. The parent directory must exist: the kit does not create a parent.

```sh
mkdir -p "$HOME/.config"
python3 scripts/tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/main"
```

Expected output:

```json
{
  "commands": {
    "editDisplayOnly": "${EDITOR:-vi} /home/you/.config/tenant-pi/overlay.json",
    "gitInitDisplayOnly": "git init /home/you/.config/tenant-pi",
    "validateDisplayOnly": "python3 /home/you/tenant-pi/scripts/tenant_pi.py validate --overlay /home/you/.config/tenant-pi/overlay.json --local-dir /home/you/.config/tenant-pi"
  },
  "complete": true,
  "created": [
    {"kind": "directory", "mode": "0700", "path": "/home/you/.config/tenant-pi"},
    {"kind": "directory", "mode": "0700", "path": "/home/you/.config/tenant-pi/inputs"},
    {"kind": "file", "mode": "0600", "path": "/home/you/.config/tenant-pi/.gitignore"},
    {"kind": "file", "mode": "0600", "path": "/home/you/.config/tenant-pi/accepted-drift.md"},
    {"kind": "file", "mode": "0600", "path": "/home/you/.config/tenant-pi/install-log.md"},
    {"kind": "file", "mode": "0600", "path": "/home/you/.config/tenant-pi/overlay.json"},
    {"kind": "file", "mode": "0600", "path": "/home/you/.config/tenant-pi/registry.json"}
  ],
  "directory": "/home/you/.config/tenant-pi",
  "targetAgentDir": "/home/you/.pi/profiles/main",
  "warnings": []
}
```

<details><summary>What runs</summary>

In `scripts/tenant_pi.py`, `main()` calls `_init_private()`:

1. `_home()` reads `HOME`. It is the only environment value that the action reads. The action needs it to know `~/.pi/agent`.
2. `_load_input()` reads the five templates that `TEMPLATES` in `scripts/private_init.py` names.
3. `check_target()` checks the form of `--target`: an absolute path, 1024 characters maximum, not the sample target of the example.
4. `_roots()` makes the list of forbidden places: the clone, `~/.pi/agent` and each known overlay target. Each place counts as written and with its symbolic links resolved.
5. `check_location()` refuses a `--dir` that is in a forbidden place.
6. `_outside()` refuses a `--target` that is in the private directory, in the clone or in `~/.pi/agent`.
7. `with_target()` makes the overlay text: the example with one changed value, `target.agentDir`.
8. `init()` of `scripts/private_init.py` creates the tree.
9. `report()` makes the output.

`init()` uses two functions of the guarded writer in `scripts/profile_write.py`. Steps 9 and 12 use the same two functions:

- `_ancestors()` opens each directory above the new one, without following a symbolic link. Each must be owned by you or by root. None can be writable by group or others, unless it has the sticky bit as `/tmp` has. The direct parent must be owned by you. The new name must not exist.
- `_create_file()` creates one file with an exclusive create, so it never replaces a file. It then checks the mode and the owner, writes the bytes and syncs the file.

The directory is created with `os.mkdir` and mode `0700`. An exclusive create is the ownership rule of the kit: the kit writes only into a directory that it has just created.

</details>

<details><summary>Files</summary>

| Path | Mode | Content | Writer |
| --- | --- | --- | --- |
| `~/.config/` | from your umask | Created by `mkdir -p` when it is absent. | you |
| `~/.config/tenant-pi/` | `0700` | The private directory. | the kit |
| `~/.config/tenant-pi/overlay.json` | `0600` | `config/config.example.json`, with your target as `target.agentDir`. One line differs from the example. | the kit; later only you |
| `~/.config/tenant-pi/registry.json` | `0600` | `{}`. Evidence for model choices. A core-only profile does not use it. | the kit; later only you |
| `~/.config/tenant-pi/install-log.md` | `0600` | An introduction, a warning and one empty entry form. | the kit; later only you |
| `~/.config/tenant-pi/accepted-drift.md` | `0600` | An introduction, a warning and an empty table. | the kit; later only you |
| `~/.config/tenant-pi/.gitignore` | `0600` | Names that Git must not track there, for example `inputs/` and `auth.json`. | the kit |
| `~/.config/tenant-pi/inputs/` | `0700` | Empty. An optional module puts its input file here. | the kit |

Read: the five templates `config/config.example.json`, `config/private/registry.json`, `config/private/install-log.md`, `config/private/accepted-drift.md` and `config/private/gitignore`.

After this step the kit never changes a file of the private directory. In this document, two later steps add one new file each: the launcher file (step 9) and the baseline file (step 12).

</details>

<details><summary>Output</summary>

| Key | Meaning |
| --- | --- |
| `complete` | `true` when the whole tree is written. |
| `directory` | The path of `--dir`. |
| `targetAgentDir` | The path that the new overlay holds as `target.agentDir`. Only with `--target`. |
| `created` | Each created path with its kind and its mode. |
| `commands.editDisplayOnly` | A line that opens the overlay in your editor. |
| `commands.validateDisplayOnly` | The `validate` line for the new overlay. |
| `commands.gitInitDisplayOnly` | A `git init` line for the directory, if you want a history of your choices. |
| `warnings` | Empty, or one text when the close of a directory failed after the tree was complete. |

A key that ends in `DisplayOnly` is text for you. The kit runs none of these lines. This rule holds for each output of the kit.

</details>

<details><summary>Not touched</summary>

- The target. The action does not create it and does not test that it is absent. Step 9 does both.
- Git. The action runs no Git command and makes no `.git` directory.
- An existing directory. If `--dir` exists, the action stops with `target_exists: init-private.dir` and changes nothing.
- The live profile. The action refuses a `--dir` or a `--target` in `~/.pi/agent`.

See [the private directory](docs/private-directory.md) for each refusal.

</details>

## Step 5: create the parent of the target

The kit creates the target directory in step 9, and only that one directory. You create its parent now. Put the parent beside the live profile, not inside it.

```sh
mkdir -p "$HOME/.pi/profiles"
```

The command prints nothing.

<details><summary>Files</summary>

| Path | Mode | Writer |
| --- | --- | --- |
| `~/.pi/` | from your umask, when it is absent | you |
| `~/.pi/profiles/` | from your umask | you |

The command does not change an existing `~/.pi` and does not touch `~/.pi/agent`.

</details>

<details><summary>Why you do this and not the kit</summary>

The guarded writer creates the target itself with an exclusive create, and no directory above it. So the owner and the mode of the parent are your decision. The kit checks the parent and refuses a bad one:

| Refusal of `generate` | Cause |
| --- | --- |
| `unsafe_path: target.parents` | The parent does not exist, or a directory above it is a symbolic link. |
| `unsafe_parent_owner: target.parent` | The parent is not yours. On some machines root owns `~/.pi`. Use another parent then, for example `~/.pi-profiles`. |
| `unsafe_owner: target.parents`, `unsafe_permissions: target.parents` | A directory above the target belongs to another user, or others can write to it. |

</details>

## Step 6: read the overlay

The overlay is the one file that holds your choices. After step 4 it is complete for a core-only profile: change nothing. Open it one time to see what you tell the kit.

```sh
${EDITOR:-vi} "$HOME/.config/tenant-pi/overlay.json"
```

After each edit by hand, check the syntax before step 7:

```sh
python3 -m json.tool "$HOME/.config/tenant-pi/overlay.json" >/dev/null && echo "JSON valid"
```

Expected output:

```text
JSON valid
```

<details><summary>The keys of the overlay</summary>

| Key | Core-only value | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | The version of the overlay form. |
| `target.agentDir` | your target | The absolute path of the new profile. |
| `selection.enable` | `["core"]` | The component IDs that you want. `core` is always there. |
| `selection.disable` | each other ID | The component IDs that you do not want. The IDs are the keys of `components` in `config/manifest.json`. |
| `paths` | `{}` | Reserved for a component with a local source. This release has none. |
| `roles` | `{}` | A model for a role, for example `interactive`. Needs the `model-routing` component. |
| `endpoints` | `{}` | An HTTPS address for an enabled component, for example a gateway. |
| `env` | `{}` | A reference of the form `${NAME}` for an enabled component. Never a value. |
| `inputs` | both `null` | The fixed names of the input files of optional modules. `null` means no file. |
| `consent` | each `false` | Three switches: `memoryCapture`, `remoteMemoryWrites` and `telemetry`. |

Five more keys are optional: `modelRoutes`, `memory`, `ownerPackages`, `ownerResources` and `unmanaged`. `overlay()` in `scripts/validate.py` has each rule. [The module guide](docs/guides/modules.md) says which keys each module needs.

The overlay has no field for a secret. An `env` value is a `${NAME}` reference only. The kit refuses a path or a model name that holds `$`, a backtick or `{{`.

</details>

<details><summary>When you change the target by hand</summary>

You need an edit only when step 4 ran without `--target`. The overlay then holds the sample target `/home/EXAMPLE_USER/new-agent`, and step 7 refuses it:

```json
{"candidate_created": false, "error": "sample_target: overlay.target.agentDir"}
```

Change the one value of `target.agentDir` to the expanded absolute path, for example `/home/you/.pi/profiles/main`. Do not paste a JSON fragment into the file. A pasted fragment can make the file invalid. The kit then names the place of the syntax error:

```json
{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}
```

The parser stops at the first character that it cannot accept. The cause is often at the end of the line before, for example a missing comma.

</details>

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `~/.config/tenant-pi/overlay.json` | read; changed only when you edit it | you |

The command `python3 -m json.tool` reads the file and writes nothing. With `>/dev/null` it does not print the file.

</details>

## Step 7: validate

The kit checks the overlay against the manifest. The check is offline and writes nothing. Run it after each change of the overlay.

```sh
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json"
```

Expected output:

```json
{"scope":"offline structural and supported-input checks only","valid":true}
```

<details><summary>What runs</summary>

In `scripts/tenant_pi.py`, `main()` does this for `validate`, `plan` and `generate`. The three actions share these steps:

1. `_load_input()` reads `config/manifest.json` and the overlay through the bounded loader. The loader accepts a regular file of 1 MiB maximum, with UTF-8 text, unique keys and 64 nesting levels maximum. It follows no symbolic link.
2. `prepare()` of `scripts/profile_plan.py` builds the **plan** in memory. It first calls `manifest()` and `overlay()` of `scripts/validate.py`.
3. `manifest()` compares the manifest with reviewed values that are fixed in the script: `REVIEWED_SOURCES`, `REVIEWED_CLAIMS` and `REVIEWED_RESOURCES`. A changed pin in the manifest alone does not pass. The values of a component with the source kind `tree` are not fixed in the script: the script reads them from `config/manifest.json` of the kit, and `manifest()` checks each resource path against the tree.
4. `overlay()` checks each key of the overlay: the form, the selection rules, each path, each role, each reference.
5. `_outside_kit()` refuses a target in the clone.
6. A target equal to `SAMPLE_TARGET` gives `sample_target`.
7. `_outside_pi_agent()` refuses a target that is `~/.pi/agent` or is under it, with `under_pi_agent`. `_home()` reads `HOME` for this rule. The target and the directory each count as written and with their symbolic links resolved.

With `--launcher`, `plan` and `generate` apply the launcher rules of step 8 between items 6 and 7.

`validate` then prints the fixed object. So `valid: true` means that the kit can build a plan from your choices. `validate` throws the plan away.

</details>

<details><summary>Files</summary>

| Path | Action |
| --- | --- |
| `config/manifest.json` | read |
| `~/.config/tenant-pi/overlay.json` | read |

No file is created or changed. The action opens no file of the target or of the live profile. It reads one environment value, `HOME`, to find `~/.pi/agent`. For the two place rules it resolves the symbolic links of the target path, of the clone path and of `~/.pi/agent`. That reads link targets only.

</details>

<details><summary>Output</summary>

| Key | Meaning |
| --- | --- |
| `valid` | `true`. A refusal prints an error object on standard error in its place. |
| `scope` | A fixed sentence. The check covers the structure and the supported inputs. It does not prove that Pi can use the profile. |

Three options exist for an overlay with optional modules: `--registry`, `--local-dir` and `--require-role`. A core-only overlay needs none of them. See [the setup guide](docs/guides/setup.md#stage-3-validate).

</details>

## Step 8: plan

The plan shows what `generate` will write, before a write. First you save the report of step 3 as a file, because `plan` and `generate` start no process. Read the plan before you continue.

```sh
python3 scripts/tenant_pi.py check-runtime > "$HOME/.config/tenant-pi/runtime.json"
python3 scripts/tenant_pi.py plan --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --launcher "$HOME/.config/tenant-pi/launch-main.sh" --runtime-report "$HOME/.config/tenant-pi/runtime.json"
```

The first command prints nothing. Expected output of the second command, shortened:

```json
{
  "commands": {
    "launchDisplayOnly": "env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/you/.pi/profiles/main pi --no-approve",
    "launchStatus": "not_runnable_until_generation_succeeds",
    "launcherDisplayOnly": "/home/you/.config/tenant-pi/launch-main.sh",
    "piInstall": {"change": null, "command": "npm install --global -- @earendil-works/pi-coding-agent@<pin>", "installed": "<pin>", "required": "<pin>", "status": "not_needed", "warning": "global_install_replaces_pi_for_all_profiles"},
    "setupDisplayOnly": []
  },
  "files": [
    {"kind": "directory", "mode": "0700", "path": "."},
    {"kind": "directory", "mode": "0700", "path": ".tenant-pi"},
    {"kind": "file", "mode": "0600", "path": ".tenant-pi/choices.json"},
    {"kind": "file", "mode": "0600", "path": "settings.json"},
    {"kind": "file", "mode": "0600", "path": ".tenant-pi/state.json"}
  ],
  "filesComplete": false,
  "readinessGaps": [
    {"code": "target_absence_unverified", "subject": "/home/you/.pi/profiles/main"}
  ],
  "runtimeReady": false,
  "targetAgentDir": "/home/you/.pi/profiles/main"
}
```

<details><summary>What runs</summary>

`plan` does the shared steps of step 7, and then these:

1. `_load_input()` reads the file of `--runtime-report`.
2. `runtime_report()` of `scripts/profile_plan.py` checks the report against `runtime` of the manifest. It refuses a report with another requirement, and a status that does not agree with its two versions.
3. `_launcher_location()` applies the place rules to the `--launcher` path: not in the target, not in the clone, not in `~/.pi/agent`. It reads `HOME` for the last rule.
4. `_preview()` makes the output from the plan. It calls `_inventory()` for `files`, `readiness()` for the gaps and `setup_commands()` for the two command keys.

The plan itself is **pure**: `prepare()` opens no file and starts no process. The same manifest and the same overlay give the same plan on each machine. That is why the measured versions come from a file that you supply, and why they change the printed output only.

</details>

<details><summary>Files</summary>

| Path | Action | Mode | Writer |
| --- | --- | --- | --- |
| `~/.config/tenant-pi/runtime.json` | created by the shell redirect `>` | from your umask | you |
| `config/manifest.json`, the overlay, `runtime.json` | read by `plan` | | none |

`runtime.json` holds the one-line report of `check-runtime`. Make it again after each change of Node or Pi. The kit cannot tell an old report from a current one.

`plan` creates no file. It does not create the launcher file, and it does not test that the launcher file or the target is absent.

</details>

<details><summary>Output</summary>

| Key | Meaning |
| --- | --- |
| `targetAgentDir` | The target from the overlay. |
| `files` | Each path that `generate` will create, relative to the target. |
| `filesComplete` | `false` in each plan. `generate` sets it to `true`. |
| `readinessGaps` | The **gaps**: facts that the kit cannot prove offline. Each gap has a `code` and a `subject`. A gap is a fact to carry, not an error. |
| `runtimeReady` | Always `false`: the kit has no live trial of a profile. Read `readinessGaps`. |
| `commands.launchDisplayOnly` | The **launch line**: the command that starts Pi with the new profile. |
| `commands.launchStatus` | `not_runnable_until_generation_succeeds` in a plan. |
| `commands.launcherDisplayOnly` | The launcher path of `--launcher`. |
| `commands.piInstall` | The global install line of Pi, with a mark. See below. |
| `commands.providerKeyWarning` | Only when a known provider key variable is set in the shell of the plan run: the names that are set, never a value. Absent here. See [the warning](docs/profile-plan.md#the-warning-for-a-provider-key-variable). |
| `commands.setupDisplayOnly` | The dependency lines that are default steps. Empty here, because Pi is installed and matches. |

`commands.piInstall` has these keys:

| Key | Meaning |
| --- | --- |
| `command` | The install line of the pinned Pi. |
| `status` | `not_needed` (the report has `match`), `needed` (`missing`), `replaces_installed` (`mismatch`) or `installed_version_unknown` (no report, or `unparsed`). |
| `installed`, `required` | The two versions from the report. |
| `change` | With `replaces_installed`: `downgrade`, `upgrade` or `unordered`. Else `null`. |
| `warning` | Always `global_install_replaces_pi_for_all_profiles`: one `pi` command serves each profile of the user. |

The shortened output leaves out seven keys. In a core-only plan they are empty or fixed:

| Key | Core-only value | Meaning |
| --- | --- | --- |
| `routeStatus` | each role `unset` | The state of each model role. |
| `routeSetup` | `[]` | Setup facts of a model route. |
| `memory` | `null` | The record of a memory module. |
| `workflow` | `mcp` and `promptr`, each with `"enabled": false` | The record of the two workflow modules. It is there also when both are off. |
| `ownerPackages`, `ownerResources`, `unmanaged` | empty | Lists from the optional overlay keys. |

</details>

<details><summary>The plan without a runtime report</summary>

Without `--runtime-report`, the kit does not know the installed versions. The plan then has two more gaps, and the Pi install line is a default step. Shortened:

```json
{
  "commands": {
    "piInstall": {"change": null, "command": "npm install --global -- @earendil-works/pi-coding-agent@<pin>", "installed": null, "required": "<pin>", "status": "installed_version_unknown", "warning": "global_install_replaces_pi_for_all_profiles"},
    "setupDisplayOnly": ["npm install --global -- @earendil-works/pi-coding-agent@<pin>"]
  },
  "readinessGaps": [
    {"code": "target_absence_unverified", "subject": "/home/you/.pi/profiles/main"},
    {"code": "node_runtime_unverified", "subject": ">=22.22.0 <23"},
    {"code": "core_runtime_unverified", "subject": "@earendil-works/pi-coding-agent@<pin>"}
  ]
}
```

With a report that has `mismatch` for Pi, the gap is `core_runtime_mismatch` with the two versions. The mark is `replaces_installed`, and the install line leaves `setupDisplayOnly`. This output comes from a run with a stand-in `pi` command:

```json
{"code": "core_runtime_mismatch", "installed": "<installed>", "required": "<pin>", "subject": "@earendil-works/pi-coding-agent@<pin>"}
```

See [the plan](docs/profile-plan.md#readiness-after-measured-facts) for each gap and each mark.

</details>

## Step 9: generate

The kit writes the profile into the target. This is the first lasting write of the kit outside the private directory. The target must be absent: the kit never writes into an existing directory.

```sh
python3 scripts/tenant_pi.py generate --overlay "$HOME/.config/tenant-pi/overlay.json" \
  --target "$HOME/.pi/profiles/main" \
  --launcher "$HOME/.config/tenant-pi/launch-main.sh" --runtime-report "$HOME/.config/tenant-pi/runtime.json"
```

Expected output, shortened:

```json
{
  "candidate_created": true,
  "commands": {
    "launchDisplayOnly": "env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/you/.pi/profiles/main pi --no-approve",
    "launchStatus": "manual_review_required",
    "launcherDisplayOnly": "/home/you/.config/tenant-pi/launch-main.sh",
    "piInstall": {"change": null, "command": "npm install --global -- @earendil-works/pi-coding-agent@<pin>", "installed": "<pin>", "required": "<pin>", "status": "not_needed", "warning": "global_install_replaces_pi_for_all_profiles"},
    "setupDisplayOnly": []
  },
  "complete": true,
  "filesComplete": true,
  "launcher": {"complete": true, "fileCreated": true, "mode": "0700", "path": "/home/you/.config/tenant-pi/launch-main.sh", "warnings": []},
  "readinessGaps": [],
  "runtimeReady": false,
  "targetAgentDir": "/home/you/.pi/profiles/main",
  "warnings": []
}
```

The profile is complete when `filesComplete` is `true`.

<details><summary>What runs</summary>

`generate` does the shared steps of steps 7 and 8, and then these:

1. `preflight()` of `scripts/launcher.py` checks the launcher path before a write: its parent is safe and the file is absent.
2. `_kit_commit()` reads the commit of the clone from the files in `.git`. It starts no `git` process.
3. `write()` of `scripts/profile_write.py`, the **writer**, creates the profile.
4. `_preview()` makes the output, as in step 8.
5. `write()` of `scripts/launcher.py` creates the launcher file. This is the last write, after the profile is complete.

The writer does these things, in this order:

1. `_validated_bytes()` checks that `--target` is equal to the target of the plan. Then it builds the plan a second time from the record in `choices.json` and compares the two. A plan that differs stops with `plan_mismatch`.
2. `_ancestors()` checks each directory above the target and that the target is absent, as in step 4.
3. `os.mkdir` creates the target with mode `0700`. The create is exclusive: a target that another process made in between stops the writer.
4. `os.mkdir` creates `.tenant-pi` with mode `0700`.
5. `_create_file()` writes `.tenant-pi/state.json` with the status `incomplete`.
6. `_create_file()` writes `settings.json`, then `.tenant-pi/choices.json`.
7. `_create_file()` writes `.tenant-pi/state.next` with the status `complete`.
8. `os.replace` renames `state.next` to `state.json`.

The marker says `incomplete` until each file is on the disk. A run that stops in the middle leaves a directory that says so. The kit has no rollback and deletes nothing: you inspect such a directory and remove it yourself.

</details>

<details><summary>Files</summary>

| Path | Mode | Content | Writer |
| --- | --- | --- | --- |
| `~/.pi/profiles/main/` | `0700` | The target. | the kit |
| `~/.pi/profiles/main/settings.json` | `0600` | The Pi settings of the profile. Pi reads this file. | the kit; later Pi |
| `~/.pi/profiles/main/.tenant-pi/` | `0700` | The records of the kit. Pi does not use them. | the kit |
| `~/.pi/profiles/main/.tenant-pi/choices.json` | `0600` | The inputs of this profile: a copy of the overlay and of the manifest, and the results of the plan. | the kit |
| `~/.pi/profiles/main/.tenant-pi/state.json` | `0600` | The marker `complete` and the record of the generation. | the kit |
| `~/.config/tenant-pi/launch-main.sh` | `0700` | The **launcher file**: two lines. | the kit |

Read: `config/manifest.json`, the overlay, `runtime.json`, the Git files of the clone (`.git/HEAD` and the reference that it names), and `HOME`.

The whole `settings.json` of a core-only profile:

```json
{"defaultProjectTrust":"ask","enableAnalytics":false,"enableInstallTelemetry":false,"packages":[]}
```

The three fixed keys are the claims of the `core` component in the manifest. `packages` is empty because no module is enabled.

The whole `state.json`:

```json
{"provenance":{"enabled":["core"],"generatedAt":"2030-01-01T12:00:00Z","kitCommit":"<commit>","kitSchemaVersion":1,"nodeRange":">=22.22.0 <23","outputs":["settings.json",".tenant-pi/choices.json",".tenant-pi/state.json"],"piVersion":"<pin>","pins":{"core":"npm:@earendil-works/pi-coding-agent@<pin>"}},"schemaVersion":1,"status":"complete"}
```

`<commit>` is the 40-character commit of the clone, or `unknown` when the clone has no Git files.

The keys of `choices.json`:

| Key | Core-only value | Meaning |
| --- | --- | --- |
| `overlay` | a copy of your overlay | The choices of this profile. |
| `manifest` | a copy of `config/manifest.json` | The pins that the profile was built from. It is most of the file. |
| `registry`, `registryDigest` | `null`, and a digest | The model evidence and its SHA-256. |
| `requiredRoles`, `credentialNames`, `pendingPackages` | `[]` | Lists that an optional module fills. |
| `roleStatus`, `routes` | each role `unset`, `null` | The model roles and routes. |
| `memory`, `workflow`, `mcpDefinitions` | `null`, the record of step 8, `null` | The records of the optional modules. |

`choices.json` holds your choices, so treat it as private like the overlay. It holds a `${NAME}` reference, never a resolved secret. It exists so that the writer and the update tools can build the same plan again without your overlay file.

The whole launcher file:

```sh
#!/bin/sh
exec env env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/you/.pi/profiles/main pi --no-approve
```

The second line is `exec env `, then the launch line of the plan, byte for byte. Step 13 explains each part.

</details>

<details><summary>Output</summary>

`generate` prints the keys of the plan, with these differences:

| Key | Meaning |
| --- | --- |
| `candidate_created` | `true`: the target directory exists after the run. In an error object, `true` means that an incomplete directory stays. |
| `complete`, `filesComplete` | `true`: each file of `files` is written and the marker says `complete`. |
| `warnings` | Empty, or one text when the close of a directory failed after the profile was complete. |
| `launcher` | Only with `--launcher`: the path, the mode, and `complete` and `fileCreated`. After a failure it has an `error` key, and the exit code is 1. |
| `commands.launchStatus` | `manual_review_required`: the line is ready, and the launch is your step. |
| `readinessGaps` | Without `target_absence_unverified`: the exclusive create proved that the target was absent. |
| `runtimeReady` | Always `false`: the kit does not prove runtime readiness. |

The `readinessGaps` list is empty only with a report with `match` for Node and Pi, and a profile without another gap.

The runtime report compares version numbers only. An empty gap list does not prove that Pi starts or that a model replies. Step 14 has those checks.

</details>

<details><summary>Not touched</summary>

- An existing directory. A second run with the same target stops and changes nothing. With the same `--launcher` it prints `target_exists: launcher.path`. Without `--launcher`, or with a new launcher path, it prints `target_exists: target`.
- The parent of the target. The kit creates no parent.
- Pi, npm and the network. The kit installs nothing and starts nothing in this step.
- The live profile `~/.pi/agent`. A target in it stops `validate`, `plan` and `generate` with `under_pi_agent: overlay.target.agentDir`, before a write.
- Your overlay. The kit reads it and does not change it.

See [the CLI contract](docs/generator.md) and [the launcher file](docs/launcher.md) for each rule.

</details>

## Step 10: install the dependencies

The kit installs nothing. For a core-only profile the one dependency is Pi itself. Read `commands.piInstall.status` in the output of step 9, and do what the table says.

| `status` | What you do |
| --- | --- |
| `not_needed` | Nothing. Go to step 11. |
| `needed` | Install Pi with the commands below. |
| `replaces_installed` | Make a decision; see "When another Pi version is installed" below. |
| `installed_version_unknown` | The kit does not know the installed version. Do step 3 and read its `pi` entry. |

For `needed`, first test whether you can write the global directory of npm:

```sh
p="$(npm config get prefix)"; test -w "$p/lib/node_modules" && test -w "$p/bin" && echo writable || echo "not writable"
```

Expected output, for a user who can write there:

```text
writable
```

Then run the line that `commands.piInstall.command` shows:

```sh
npm install --global -- @earendil-works/pi-coding-agent@<pin>
```

Warning: a global install replaces the `pi` command of each profile of the user.

Do step 3 again after an install. The `pi` entry must have `match`.

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `<npm prefix>/lib/node_modules/@earendil-works/pi-coding-agent/` | created by the install | npm |
| `<npm prefix>/bin/pi` | created by the install: a link into the package | npm |
| `~/.npm/` | The cache and the logs of npm. `npm config get prefix` already writes one log file into `~/.npm/_logs`. | npm |

`<npm prefix>` is the output of `npm config get prefix`. The table shows the global npm package layout. Not verified: a fresh install with these commands on a clean client.

Pi is one program for the whole user account. A profile is a directory of data. Each profile of the user runs the same `pi` command, so the profile does not hold a copy of Pi.

</details>

<details><summary>When you cannot write the global directory</summary>

When the test prints `not writable`, the global command fails. Install Pi under a directory that you own, and put it on `PATH` for the current shell:

```sh
npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@<pin>
export PATH="$HOME/.npm-global/bin:$PATH"
```

The `export` line changes the current shell only. To keep it, you add the line to your shell startup file yourself. The kit never edits that file.

</details>

<details><summary>When another Pi version is installed</summary>

With `replaces_installed`, the global line is not a default step. It replaces the installed Pi for each profile, and `change` says whether that is a `downgrade` or an `upgrade`. You have three choices:

- Stop.
- Keep the installed Pi. The gap `core_runtime_mismatch` stays, and you record it in step 15.
- Install `<pin>` with the `--prefix` form above. The installed Pi stays in its place.

See [the setup guide](docs/guides/setup.md#pi) for the full rule.

</details>

<details><summary>Not touched</summary>

- The kit runs none of these commands. They are yours.
- A core-only profile needs no other package. An optional module can add steps here; see [what an optional module adds](#what-an-optional-module-adds).

</details>

## Step 11: decide how Pi gets a credential

Pi needs a credential for a model provider. The kit writes no credential and reads none. You choose one of two ways before the first launch.

| Way | What you do | Where the credential is |
| --- | --- | --- |
| A login inside Pi | Nothing now. In step 13 you run `/login` inside Pi and choose a provider. | Pi writes `auth.json` in the target. |
| A key in the shell | Export the key of your provider in the shell that will launch Pi. | In the environment of that shell only. No file of the kit holds it. |

To test that a name is set without printing its value, replace `EXAMPLE_PROVIDER_API_KEY` with your provider's documented variable name:

```sh
test -n "${EXAMPLE_PROVIDER_API_KEY:-}" && echo set || echo unset
```

The command prints `set` or `unset`.

<details><summary>What you must know about keys in the shell</summary>

- Pi reads a provider key from the environment of the launching shell, including in a profile with no login. Not verified: which variable names Pi reads for each provider. Use the name that the Pi documentation gives. A key exported for another tool can pay for a prompt in the new profile. See [print mode](docs/launcher.md#print-mode).
- A profile is not a sandbox. Each process of your user can read each profile, the private directory and the environment. See [the privacy guide](docs/guides/privacy.md#configuration-separation-is-not-isolation).
- The launcher file holds no key. The kit builds the launch line from the overlay, and the overlay has no field for a secret.

</details>

<details><summary>Not touched</summary>

- The kit reads no credential file and no environment value for a credential. `init-private`, `baseline`, `validate`, `plan` and `generate` read `HOME` and no other environment value, with one exception: `plan` tests whether a known provider key variable name is set and reads no value; see [the warning](docs/profile-plan.md#the-warning-for-a-provider-key-variable).
- `check-runtime` reads `PATH` to find the tools, and `TMPDIR` (or `TEMP` or `TMP`) for its temporary directory. It passes the whole environment of the shell to the three `--version` processes, with `PI_CODING_AGENT_DIR` replaced for Pi. So a provider key that the shell exports reaches these three processes.
- The other actions read no environment value.
- `auth.json` of the live profile. The kit copies no login from one profile to another, so the new profile starts with no login.

</details>

## Step 12: record the baseline of the live profile

Before the first launch, the kit records the state of the live profile. After the launch, step 14 compares the directory with this record. The comparison shows whether the live profile changed after the record.

```sh
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

Expected output:

```json
{
  "baseline": {"complete": true, "fileCreated": true, "mode": "0600", "path": "/home/you/.config/tenant-pi/live-baseline.json", "warnings": []},
  "dir": "/home/you/.pi/agent",
  "present": true,
  "recordedAt": "2030-01-01T12:00:00Z",
  "summary": {"below": 1, "entries": 2}
}
```

Run the command also when step 1 printed `absent`. The baseline then records that the directory is absent. Close each Pi that runs in the live profile first: such a Pi also changes the directory.

Two more cases:

- When step 1 printed `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR`, record one more baseline for each such directory. Give each its own `--dir` and its own `--out` file.
- When `~/.pi/agent` or a directory above it is a symbolic link, the action stops with `not_directory: baseline.dir`. Run `realpath "$HOME/.pi/agent"`, and give that path as `--dir` here and in step 14.

See [the setup guide](docs/guides/setup.md#stage-8-launch) for both cases.

<details><summary>What runs</summary>

In `scripts/tenant_pi.py`, `main()` calls `_baseline()`:

1. `_home()` reads `HOME`.
2. `check_location()` of `scripts/baseline.py` refuses an `--out` path in the clone, in `~/.pi/agent` or in `--dir`.
3. `preflight()` checks the parent of `--out` and that the file is absent, with `_ancestors()` as in step 4.
4. `_dir_state()` opens `--dir` and calls `scan()`.
5. `scan()` lists the directory at each level and makes one status call for each entry. It opens directories only and follows no symbolic link.
6. `record()` and `encode()` make the bytes of the file. `write()` creates the file with `_create_file()`.

</details>

<details><summary>Files</summary>

| Path | Action | Mode | Writer |
| --- | --- | --- | --- |
| `~/.pi/agent` and each directory in it | listed | | none |
| `~/.config/tenant-pi/live-baseline.json` | created | `0600` | the kit |

The baseline file is one JSON object. It has the path, the time `recordedAt`, and one row for each direct entry of the directory: name, kind, size and modification time. A row of a directory also has the count of the entries below it and one SHA-256 digest over their names, sizes and times.

The file holds no file content. Below the first level it holds no name. It still shows the names of the direct entries, so treat it as private.

</details>

<details><summary>Output</summary>

| Key | Meaning |
| --- | --- |
| `baseline` | The created file: its path and mode, and `complete` and `fileCreated`. |
| `dir` | The path of `--dir`. |
| `present` | `true` when the directory exists. |
| `recordedAt` | The time of the record, in UTC. The comparison covers the time after it. |
| `summary.entries` | The count of the direct entries. |
| `summary.below` | The count of the entries below them, at all levels. |

The counts describe a synthetic directory. Your live profile can have different counts.

When the directory is absent, `present` is `false` and the two counts are 0:

```json
{
  "baseline": {"complete": true, "fileCreated": true, "mode": "0600", "path": "/home/you/.config/tenant-pi/live-baseline.json", "warnings": []},
  "dir": "/home/you/.pi/agent",
  "present": false,
  "recordedAt": "2030-01-01T12:00:00Z",
  "summary": {"below": 0, "entries": 0}
}
```

The baseline file then holds `"present": false`, an empty `entries` list and `"mtimeNs": null`.

</details>

<details><summary>Not touched</summary>

- No file of the live profile is opened. `auth.json`, each session and `settings.json` get one status call each.
- The action changes no entry of the directory.
- A baseline is never replaced. A second run with the same `--out` stops with `target_exists: baseline.out`. A baseline from a time after the launch proves nothing.

See [the directory baseline](docs/directory-baseline.md).

</details>

## Step 13: launch the profile and log in

You start Pi with the new profile for the first time. This is the first step in which Pi runs with the target, and from here on Pi writes into the target. The kit does not run in this step.

```sh
"$HOME/.config/tenant-pi/launch-main.sh"
```

Pi shows its own start screen with its version and waits for your input. For a login inside Pi, type:

```text
/login
```

Choose your provider and follow its steps. Then exit Pi.

<details><summary>What runs</summary>

The launcher file runs one line:

```sh
exec env env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/you/.pi/profiles/main pi --no-approve
```

| Part | Why it is there |
| --- | --- |
| `exec` | The shell becomes the Pi process. No shell process stays. |
| `env` (the first) | A POSIX shell does not accept an assignment after `exec`. An optional module can put an assignment first in the launch line, and this `env` then applies it to the Pi process. In a core-only line no assignment is first, so this `env` only starts the second `env`. |
| `env -u PI_CODING_AGENT_SESSION_DIR` | Removes an inherited session directory for this process. Pi then keeps the sessions in the target. |
| `PI_CODING_AGENT_DIR=<target>` | Selects the new profile for this process. Without it, Pi opens the live profile. The second `env` applies this assignment. |
| `pi` | The Pi command that the shell finds on `PATH`. |
| `--no-approve` | A Pi option. Pi then ignores the files of a project directory that need a trust decision (Pi document `docs/cli.md`, read in the Pi 1.0.2 package). |

The file passes no argument to Pi. To give Pi an argument, type the launch line by hand, as in step 14. An optional module can put more assignments in front of the line.

</details>

<details><summary>Files</summary>

Pi can write these entries into the target after a login and a prompt. Not verified: their modes across Pi versions.

| Path | Mode | Content | Writer |
| --- | --- | --- | --- |
| `~/.pi/profiles/main/auth.json` | `0600` | The login of `/login`. Keep it private. | Pi |
| `~/.pi/profiles/main/sessions/` | `0755` | The session files, in one directory for each working directory. | Pi |
| `~/.pi/profiles/main/models-store.json` | `0600` | Model data that Pi keeps. | Pi |
| `~/.pi/profiles/main/bin/` | `0755` | Helper tools that Pi downloads when the machine does not have them, for example `fd` and `ripgrep`. | Pi |
| `~/.pi/profiles/main/settings.json` | `0600` | Pi can change the generated settings. | Pi |

The list is not exhaustive. Pi can create more entries, for example `npm/` and the state directories of extensions; see [INSTALL.md](INSTALL.md#checks).

The purpose of `bin/` comes from a reading of the installed Pi 1.0.2 package (`dist/config.js` and `dist/utils/tools-manager.js`). Not verified: the same in another Pi version, the content of `models-store.json`, and the keys that Pi added to `settings.json`. The kit opens none of these files.

Pi can change `settings.json` after each command that changes a setting. The kit does not write the file again. To see the difference between two profiles, use the `compare` action; see [the candidate update guide](docs/guides/candidate-update.md#after-a-native-pi-operation).

</details>

<details><summary>Not touched</summary>

- The live profile, when the launch line is used as it is. Step 14 checks it.
- The private directory. Pi does not know it.
- The clone. A core-only profile reads nothing from it.

Not verified: the interactive launch and provider login as one complete procedure.

</details>

## Step 14: run the checks

You check that the new profile works and that it stayed inside its directory. Record each check as passed, failed or not run. A check that did not run is "not run", never "passed".

1. Read the Pi version of the profile. The output must be `<pin>`.

   ```sh
   PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --version
   ```

2. Read the start screen of step 13. It must show no extension error and no peer warning.

3. Send the fixed prompt in print mode. The command is the launch line of the plan with `-p` and the prompt. The reply must hold `43`, and the exit status must be 0.

   ```sh
   env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR="$HOME/.pi/profiles/main" pi --no-approve -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"
   ```

4. Compare the live profile with its baseline. The result must be `unchanged`.

   ```sh
   python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"
   ```

Expected output of check 4:

```json
{
  "added": [],
  "dir": "/home/you/.pi/agent",
  "directoryModified": false,
  "modified": [],
  "now": "present",
  "recordedAt": "2030-01-01T12:00:00Z",
  "removed": [],
  "result": "unchanged",
  "scope": "Compares the name, kind, size and modification time of each entry at all levels, and names the direct entries only. Opens no file. Covers the time after recordedAt only.",
  "was": "present"
}
```

<details><summary>What runs</summary>

Checks 1 and 3 run Pi, not the kit. With `-p`, Pi sends one prompt, prints the final reply and exits. The prompt does not hold the number `43`, so the number can only come from a model. See [print mode](docs/launcher.md#print-mode).

Check 4 is a kit action. In `scripts/tenant_pi.py`, `main()` calls `_check_baseline()`:

1. `_load_input()` reads the baseline file.
2. `saved_record()` of `scripts/baseline.py` checks that the file names the same directory as `--dir`.
3. `_dir_state()` scans the directory, as in step 12.
4. `compare()` compares the two states and makes the output.

</details>

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `~/.config/tenant-pi/live-baseline.json` | read | none |
| `~/.pi/agent` and each directory in it | listed | none |
| `~/.pi/profiles/main/sessions/` | Check 3 adds one session file. | Pi |

`check-baseline` writes nothing.

</details>

<details><summary>Output</summary>

| Key | Meaning |
| --- | --- |
| `result` | `unchanged`, `changed` or `no_baseline`. |
| `was`, `now` | `present` or `absent`: the directory at the baseline and now. |
| `added`, `removed`, `modified` | The names of the direct entries that differ. |
| `directoryModified` | `true` when an entry was made or removed in the directory itself. |
| `recordedAt` | The time of the baseline. |
| `scope` | A fixed sentence that says what the comparison covers. |

The exit code is 0 for `unchanged` and 1 for the two other results.

When the directory was absent at the baseline and is absent now, the result is `unchanged` and the exit code is 0. The output then has these values, shortened:

```json
{"now": "absent", "result": "unchanged", "was": "absent"}
```

`changed` does not say which process made the change. A Pi that you ran in the live profile after `recordedAt` also changes it. Observed with Pi 1.0.2 and a `settings.json` in the directory: a bare `pi --version` changes its modification time. Not verified: other Pi versions. See [how to read the result](docs/directory-baseline.md#how-to-read-the-result).

</details>

<details><summary>Verification limits</summary>

- Not verified: checks 1 to 3 as part of a complete clean-client install.
- The check 4 example shows the form of an `unchanged` result without a Pi launch. It does not prove a launch boundary.

</details>

## Step 15: record the install

You write down what you ran and what you saw. The install log is the memory of this machine: a later update starts from it. The kit never reads the log.

```sh
git -C "$HOME/tenant-pi" rev-parse HEAD
${EDITOR:-vi} "$HOME/.config/tenant-pi/install-log.md"
```

The first command prints the commit of the clone. Add one entry to the log with the fields of the form that is in the file:

```text
## YYYY-MM-DD: short title

- Kit commit:
- Overlay:
- Target:
- Commands:
- Result:
- Model replied:
- Reply matched:
- Live agent directory:
- Not verified:
```

Warning: do not write a secret value into the log. Write the name of a credential, never its value.

<details><summary>Files</summary>

| Path | Action | Writer |
| --- | --- | --- |
| `~/.config/tenant-pi/install-log.md` | changed | you |

The form in the file says what each field holds. "Model replied" and "Reply matched" are the two results of check 3. "Live agent directory" is the `result` of check 4 with its `recordedAt` time.

</details>

<details><summary>A Git history for the private directory</summary>

Step 4 printed a `git init` line for the private directory. It is optional. With it, each change of your overlay has a history, and a second machine can start from the same choices. The `.gitignore` of the directory keeps `inputs/` and the usual credential file names out of Git. It is not a security control: read `git status` before each commit.

</details>

## The footprint after a core-only install

This table has each path that the install created or changed on the machine.

| Path | Kind and mode | Writer | Purpose |
| --- | --- | --- | --- |
| `~/tenant-pi/` | directory | Git | The clone. Not changed after the clone. |
| `~/.config/`, `~/.pi/` | directories, mode from your umask | you (steps 4 and 5) | The parents. Only when they were absent before the install. |
| `~/.config/tenant-pi/` | directory `0700` | the kit (step 4) | The private directory. |
| `~/.config/tenant-pi/overlay.json` | file `0600` | the kit, then you | Your choices. |
| `~/.config/tenant-pi/registry.json` | file `0600` | the kit, then you | Model evidence. `{}` for a core-only profile. |
| `~/.config/tenant-pi/install-log.md` | file `0600` | the kit, then you | Your record of each install. |
| `~/.config/tenant-pi/accepted-drift.md` | file `0600` | the kit, then you | Your list of differences that you keep on purpose. |
| `~/.config/tenant-pi/.gitignore` | file `0600` | the kit | Names that Git must not track there. |
| `~/.config/tenant-pi/inputs/` | directory `0700` | the kit | Empty. For the input files of optional modules. |
| `~/.config/tenant-pi/runtime.json` | file, mode from your umask | you (step 8) | The saved report of `check-runtime`. |
| `~/.config/tenant-pi/launch-main.sh` | file `0700` | the kit (step 9) | The launcher file. |
| `~/.config/tenant-pi/live-baseline.json` | file `0600` | the kit (step 12) | The baseline of the live profile. |
| `~/.pi/profiles/` | directory | you (step 5) | The parent of the target. |
| `~/.pi/profiles/main/` | directory `0700` | the kit (step 9) | The target: the new profile. |
| `~/.pi/profiles/main/settings.json` | file `0600` | the kit, then Pi | The Pi settings. |
| `~/.pi/profiles/main/.tenant-pi/choices.json` | file `0600` | the kit | The inputs of this profile. |
| `~/.pi/profiles/main/.tenant-pi/state.json` | file `0600` | the kit | The marker and the record of the generation. |
| `~/.pi/profiles/main/auth.json` | file `0600` | Pi (step 13) | The login. |
| `~/.pi/profiles/main/sessions/` | directory | Pi | The sessions. |
| `~/.pi/profiles/main/models-store.json` | file `0600` | Pi | Model data of Pi. |
| `~/.pi/profiles/main/bin/` | directory | Pi | Helper tools of Pi. |
| `<npm prefix>/lib/node_modules/@earendil-works/pi-coding-agent/`, `<npm prefix>/bin/pi` | package and link | npm (step 10) | Pi itself. Only when you installed it. |
| `~/.npm-global/` | directory | npm (step 10) | Pi under a directory that you own. Only when you used the `--prefix` form. |
| `~/.npm/` | directory | npm | The cache and the logs of npm. |
| One empty directory under `$TMPDIR` | directory `0700` | you (step 1) | From `mktemp -d`. You can remove it. |
| `$TMPDIR/node-compile-cache/` | directory | Pi (seen after `pi --version` in steps 1 and 3) | The compile cache of Node. Observed with Pi 1.0.2. You can remove it. |

The Pi entries of the target are examples, not a complete list. Pi can create more entries, for example `npm/`; see step 13.

The kit itself writes in three places only: the private directory, the target and one temporary directory that it removes. In each place it creates new entries and never replaces an entry that existed before the run.

What the install does not change:

- The live profile `~/.pi/agent`. The kit refuses a target in it, and step 14 checks it. A live directory that only `PI_CODING_AGENT_DIR` names does not have the refusal.
- Each shell startup file, and `PATH`.
- System packages, services and timers.
- The clone, after step 2.

Two kit actions show the kit profiles of the machine. Both are read-only:

```sh
python3 scripts/tenant_pi.py list --parent "$HOME/.pi/profiles"
python3 scripts/tenant_pi.py inventory --dir "$HOME/.pi/profiles/main"
```

`list` reads `.tenant-pi/state.json` of each directory below the parent. `inventory` names the packages, extensions, skills and prompts of one profile. See [the candidate list](docs/candidate-list.md) and [the profile inventory](docs/profile-inventory.md).

## Remove the install

The install has no service and no hook, so you remove it with the removal of its directories. Do the steps in this order.

1. Exit each Pi that uses the profile.

2. Remove the target.

   ```sh
   rm -r "$HOME/.pi/profiles/main"
   ```

   Warning: this deletes the login in `auth.json` and each session of the profile.

3. Remove the private directory.

   ```sh
   rm -r "$HOME/.config/tenant-pi"
   ```

   Warning: this deletes your overlay, your install log, the launcher file and the baseline. If you ran `git init` there, it also deletes that Git history. Keep a copy if you want to generate the profile again.

4. Remove the parent of the target. The command works only when the directory is empty.

   ```sh
   rmdir "$HOME/.pi/profiles"
   ```

5. Remove `~/.pi` and `~/.config`, only when you created them in steps 4 and 5. `rmdir` fails on a directory that holds an entry, so it never removes your files.

   ```sh
   rmdir "$HOME/.pi"
   rmdir "$HOME/.config"
   ```

6. Remove the clone.

   ```sh
   rm -rf "$HOME/tenant-pi"
   ```

7. Remove Pi, only when you installed it for this profile and no other profile uses it.

   ```sh
   npm uninstall --global @earendil-works/pi-coding-agent
   ```

   For the `--prefix` form of step 10, give the same prefix:

   ```sh
   npm uninstall --global --prefix "$HOME/.npm-global" @earendil-works/pi-coding-agent
   ```

   Warning: this removes the `pi` command for each profile that uses that install, also for the live profile.

These paths stay after the seven steps:

- `~/.npm/`: the cache and the logs of npm. npm uses it for each project of the user. It is a cache: you can remove it.
- `~/.npm-global/`: the prefix directory of step 10. Remove it only when it holds no other package. Not verified: what npm leaves in it after the uninstall.
- The empty directory of step 1 under `$TMPDIR`. Remove it with `rmdir`.
- `$TMPDIR/node-compile-cache/`: the compile cache of Node. It is a cache: you can remove it.

The removal of `auth.json` does not end a login at the provider. Use the controls of the provider to end it. If you added a `PATH` line or an exported key to a shell startup file yourself, remove that line yourself.

Not verified: the removal commands. The list follows from the footprint table.

## The components

```text
 THE CLONE  ~/tenant-pi                        THE PRIVATE DIRECTORY  ~/.config/tenant-pi
 reviewed, the same for each user              your choices and records, mode 0700
+-------------------------------+             +--------------------------------------+
| config/manifest.json          |             | overlay.json         your choices    |
|   components, pins, runtime   |  step 4     | registry.json        model evidence  |
| config/config.example.json ---+------------>| inputs/              module inputs   |
| config/private/  templates ---+  copy       | install-log.md       your record     |
| packages/  optional modules   |             | runtime.json         versions        |
| scripts/tenant_pi.py          |             | live-baseline.json   baseline        |
+---------------+---------------+             | launch-main.sh       launcher file   |
                |                             +---+------------------------------+---+
                | the manifest                    | the overlay                  ^
                v                                 v                              |
        +----------------------------------------------------+                   |
        | validate --> the plan (in memory, pure)            |                   |
        |                   |                                |                   |
        |                   +--> plan: prints files, gaps,   |                   |
        |                   |    commands; writes nothing    |                   |
        |                   v                                |                   |
        |              the writer (generate)                 +-------------------+
        +-------------------+--------------------------------+   writes the launcher file
                            |
                            | creates a new directory, one time
                            v
 THE GENERATED PROFILE  ~/.pi/profiles/main
+-------------------------------------+        THE PI RUNTIME
| settings.json            for Pi     |<------ one npm package for the user;
| .tenant-pi/choices.json  the inputs |        the launcher file starts it with
| .tenant-pi/state.json    the marker |        PI_CODING_AGENT_DIR=<target>;
| auth.json, sessions/, ...  from Pi  |        it reads and writes the target
+-------------------------------------+

 THE LIVE PROFILE  ~/.pi/agent
 The kit refuses a target in it. baseline and check-baseline show a change of it.
```

| Component | Where | Who writes it | What it is |
| --- | --- | --- | --- |
| The clone | `~/tenant-pi` | Git | The reviewed kit. It holds no value of yours. |
| The manifest | `config/manifest.json` in the clone | the kit maintainers | Each component with its source, pin and status, and the runtime requirements. The public input of the plan. |
| The overlay | `overlay.json` in the private directory | you | Your choices: the target, the selection, the models. The private input of the plan. |
| The private directory | `~/.config/tenant-pi` | the kit one time, then you | The home of the overlay and of each record of this machine. Outside the clone, so that a kit update cannot touch it. |
| The registry | `registry.json` in the private directory | you | Your evidence that a provider has a model. Needed only for model routes. |
| The plan | in memory | `prepare()` | The files, the launch line and the gaps that follow from the manifest and the overlay. Pure: no file, no process. |
| The writer | `scripts/profile_write.py` | the kit maintainers | The one function that creates a profile. It creates a new directory or stops. |
| The generated profile | the target | the kit one time, then Pi | `settings.json` for Pi, and `.tenant-pi/` with the records of the kit. |
| The launcher | `launch-main.sh` in the private directory | the kit one time | Two lines that start Pi with the target as its profile. |
| The live profile | `~/.pi/agent` | Pi | The profile that a bare `pi` opens. Not an input and not an output of the kit: the kit refuses a target in it. |
| The Pi runtime | the npm prefix | npm | The `pi` program. One for the user, shared by each profile. |

The reasons for this structure:

- **Two inputs.** The manifest is public and reviewed. The overlay is private. A kit update changes the manifest and never your choices. A profile is always "this manifest plus this overlay".
- **A pure plan.** The plan does not depend on the machine. The writer builds it a second time from the record and refuses a difference. So `choices.json` is enough to explain each byte of `settings.json`.
- **New directories only.** The kit has no code that edits an existing profile. An update is a new target from the same overlay, a comparison, and a launch with the launcher file of the new target. The old profile stays as the way back. See [the candidate update guide](docs/guides/candidate-update.md).
- **Display-only commands.** Each command that changes the machine is text in an output key that ends in `DisplayOnly`, or in `piInstall`. You read it and run it. Of the actions, only `check-runtime` starts a process: three `--version` commands.
- **Gaps, not promises.** The kit cannot prove offline that Pi loads a package or that a model replies. It lists each such fact as a gap. A gap goes away only when a fact proves it.
- **A profile is a directory, not a sandbox.** `PI_CODING_AGENT_DIR` selects the data of one Pi process. Each process of your user can still read each profile. See [the privacy guide](docs/guides/privacy.md).

### The scripts

| Script | Role |
| --- | --- |
| `scripts/tenant_pi.py` | The command line: the options, the bounded file loader and each action. |
| `scripts/validate.py` | The rules of the manifest and of the overlay. |
| `scripts/profile_plan.py` | The plan: `prepare()`, `readiness()`, `setup_commands()` and `runtime_report()`. |
| `scripts/profile_write.py` | The guarded writer: `write()`, `_ancestors()` and `_create_file()`. |
| `scripts/private_init.py` | The private directory of `init-private`. |
| `scripts/launcher.py` | The launcher file. |
| `scripts/check_runtime.py` | The three version processes of `check-runtime`. |
| `scripts/baseline.py` | The scan and the comparison of `baseline` and `check-baseline`. |
| `scripts/kit_commit.py` | Reads the commit of the clone without a Git process. |
| `scripts/model_routes.py`, `scripts/memory_modules.py`, `scripts/workflow_modules.py` | The parts of the plan that the optional modules add. |
| `scripts/candidate_compare.py`, `scripts/carry.py`, `scripts/candidate_list.py`, `scripts/profile_inventory.py` | The update tools: `compare`, `carry`, `list` and `inventory`. |
| `scripts/publish_check.py`, `scripts/doc_check.py`, `scripts/examples.py` | The checks of the kit itself. |

`python3 scripts/tenant_pi.py --help` lists the actions. Each action has its own `--help`.

## What an optional module adds

Each component other than `core` is optional. You enable one when you move its ID from `selection.disable` to `selection.enable` in the overlay. An enabled module can add to the footprint in the eight ways of this table. The examples show the output of `generate`.

| Class of change | Example |
| --- | --- |
| An entry in `packages` of `settings.json` | `context-meter`, an in-tree module: an entry with the absolute path of `packages/tenantext` in the clone, and a filter that loads one extension. |
| More keys in `settings.json` | `mcp` adds `"extensions": ["-builtin:mcp"]`. A model role adds `defaultProvider`, `defaultModel` and `defaultThinkingLevel`. |
| One more file in the target | `mcp` adds `mcp-adapter.json`. `hermes` adds `hermes-memory-config.json`. |
| An assignment in front of the launch line | `mcp` puts `PI_MCP_CONFIG_MODE=exclusive` in front. The gateway route puts `TENANTEXT_LITELLM_BASE_URL=<address>` in front. |
| More dependency steps for you | `mcp` adds a `pi update --extensions` line to `setupDisplayOnly`. An in-tree module of `packages/tenantext` needs `npm ci --ignore-scripts` in that directory, which leaves `node_modules/` in the clone. |
| More inputs in the private directory | `mcp` reads `inputs/mcp-adapter.json`, and `validate`, `plan` and `generate` then need `--local-dir`. A model route reads `registry.json` with `--registry`. |
| State outside the target at run time | The `wiki` module can keep a vault in `~/.llm-wiki/`. The `mcp` adapter keeps tokens in the keyring of the operating system. |
| More gaps | `context-meter` adds three: `package_runtime_unverified`, `pi_line_unqualified` and `kit_test_missing`. |

The `packages` entry of the `context-meter` example:

```json
{"extensions": ["extensions/context-meter/index.ts"], "prompts": [], "skills": [], "source": "/home/you/tenant-pi/packages/tenantext", "themes": []}
```

This entry is the reason for the warning of step 2. The profile points at the clone, so the clone must stay in its place.

The launch line of the `mcp` example:

```text
PI_MCP_CONFIG_MODE=exclusive env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/you/.pi/profiles/ex-mcp pi --no-approve
```

Three rules hold for each module:

- A module that stays disabled adds no file, no key and no assignment.
- The module can need a credential. The credential reaches Pi from the shell or from a Pi login, never from a file of the kit.
- `readinessGaps` is not empty for a profile with a module that has a gap.

No optional module passed an accepted live trial in this release. Read [the module guide](docs/guides/modules.md) before you enable one. It has one row for each component, with its inputs, its credential method and its state. The details are in [in-tree packages](docs/packages.md), [memory modules](docs/memory-modules.md), [workflow modules](docs/workflow-modules.md) and [model routes](docs/model-routes.md).

## Where the outputs come from

The output examples use Linux `x86_64`, Node `22.22.3`, npm `10.9.8`, Python `3.11.2` and Git `2.39.5`.
The runtime observations use Pi 1.0.2. `<pin>` represents the current manifest pin, not a new runtime observation.
The examples use disposable home directories and synthetic live profiles. `/home/you` replaces each home path.
A stand-in `pi` command supplies the `mismatch` examples; those examples show the report shape, not a real Pi version.

Not verified:

- The complete procedure with the current Pi pin.
- A fresh clone followed by a Pi install on a clean client.
- The interactive launch, provider login and model-reply checks as one complete procedure.
- The removal commands.

## More documents

| Document | For |
| --- | --- |
| [The setup guide](docs/guides/setup.md) | The same install as nine stages, with each option. |
| [INSTALL.md](INSTALL.md) | The same install for an installing agent. |
| [The module guide](docs/guides/modules.md) | Each component. |
| [The candidate update guide](docs/guides/candidate-update.md) | A new kit version: regenerate, compare, switch. |
| [The privacy guide](docs/guides/privacy.md) | What the kit separates and what it does not. |
| [Troubleshooting](docs/guides/troubleshooting.md) | Each diagnostic and its fix. |
| [The CLI contract](docs/generator.md) | Each action, each input rule. |
| [The private directory](docs/private-directory.md), [the plan](docs/profile-plan.md), [the launcher file](docs/launcher.md), [the runtime check](docs/check-runtime.md), [the directory baseline](docs/directory-baseline.md) | The reference of one action each. |
