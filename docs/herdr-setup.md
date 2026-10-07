# Herdr and the question tool

Status: offline implementation, not a qualified runtime. This document gives the facts of two parts of a coordination setup: the Herdr application with its bundled skill, and the Pi question extension. The guided steps are in [`INSTALL.md`](../INSTALL.md) and in the install skill.

## The parts

| Part | What it is | How the kit handles it |
| --- | --- | --- |
| Herdr application | A host tool: the `herdr` command and its server. It is not an npm package and not a package of a profile. | The kit does not install, update or start it. The `check-herdr` action reports the command. |
| Herdr skill | The skill directory `packages/tenantext/skills/herdr` of this kit. | The component `herdr` loads it in one generated profile. The installer of the skill is the separate option for every harness of the user. |
| Question extension | The npm package `@juicesharp/rpiv-ask-user-question`. It gives Pi the `ask_user_question` tool. | The component `questions` declares it as a package of one generated profile. |

The question extension is a Pi extension. Claude Code has its own question tool. The kit installs no Pi extension into Claude Code.

The third-party package `@ogulcancelik/pi-herdr` is not a part of this kit.

## The Herdr check

```sh
python3 scripts/tenant_pi.py check-herdr
python3 scripts/tenant_pi.py check-herdr --herdr /usr/local/bin/herdr
```

| Option | Default | Rule |
| --- | --- | --- |
| `--herdr <path>` | `herdr` on `PATH` | Absolute path, else `absolute_path: check-herdr.herdr` |

The action starts one command at most: `<herdr> --version`. The command is an argument list. No shell runs. Standard input is `/dev/null`. The timeout is 20 seconds. A `herdr` that is not found starts no process.

The action does not install, update, start or stop Herdr. It reads no Herdr session, no Herdr configuration file and no profile.

One JSON object on standard output:

```json
{"herdr":{"installed":"<version>","status":"present"}}
```

| Status | Meaning | `installed` | Exit code |
| --- | --- | --- | --- |
| `present` | The command ran and gave a version. | The version token | 0 |
| `missing` | The system cannot find or may not start the executable. | `null` | 1 |
| `unparsed` | The command gave no usable version: unknown output, an exit code other than 0, or a timeout. | `null` | 1 |

Bad input gives exit code 2 and a static diagnostic on standard error. `installed` holds only a version token of the grammar in [the runtime version check](check-runtime.md). Other output of the command never appears.

The manifest names no required Herdr version. `present` proves only that the command starts. It does not prove a running server, a working session or a loaded skill.

## Verification results

Five results are separate. One result does not prove another. A readable skill file and a present command do not prove a working session or a working question tool.

| Result | How to get it | Values | Offline |
| --- | --- | --- | --- |
| Herdr command | `check-herdr` | `present` with the version, `missing`, `unparsed` | Runs one `herdr --version`. |
| Herdr skill files in the candidate | `inventory --dir <candidate>`, key `coordination.herdrSkill` | `readable`, `not_readable`, `not_declared` | yes |
| Question extension in the candidate | `inventory --dir <candidate>`, key `coordination.questionExtension` | `installed`, `declared`, `not_declared` | yes |
| Interactive question dialog | An interactive Pi session of the candidate, with the approval of the owner | passed, failed, not run | no: always `unverified` |
| Temporary Herdr session | A named test session, with the approval of the owner | passed, failed, blocked, not run | no: always `not_run` |

### In the plan

With `herdr` in `selection.enable`, `plan` and `generate` list these gaps with the subject `herdr`, beside the gaps of the manifest:

| Gap | Meaning | What changes it |
| --- | --- | --- |
| `herdr_cli_unverified` | No report of the `herdr` command was given. | `--herdr-report` with `present` removes it. `missing` gives `herdr_cli_missing`. `unparsed` gives `herdr_cli_unparsed`. |
| `herdr_session_unverified` | No kit action starts or reads a Herdr session. | Nothing offline. |
| `host_tool_required` | The skill needs the `herdr` command and Python 3 on the host. | Nothing: it is a fact of the component. |

With `questions`, the gap `question_ui_unverified` stays in every plan. No kit action opens a question dialog.

`plan` and `generate` start no process. Give them the report as a file:

```sh
python3 scripts/tenant_pi.py check-herdr > /path/to/herdr.json
python3 scripts/tenant_pi.py plan --overlay /path/to/overlay.json --herdr-report /path/to/herdr.json
```

The file must be the unchanged output of `check-herdr`: else `herdr_report_status` or `herdr_report_installed`. The kit cannot tell a current report from an old one. The report changes the printed gaps only. The generated files are the same with and without it.

### In the inventory

`inventory` adds the `coordination` block to its report:

```json
{"herdrCli":"not_checked","herdrSession":"not_run","herdrSkill":"readable","questionExtension":"declared","questionUi":"unverified"}
```

| Key | Value | Meaning |
| --- | --- | --- |
| `herdrSkill` | `not_declared` | No local package of `settings.json` has the filter `skills/herdr`. |
| | `readable` | The file `skills/herdr/SKILL.md` below that package is a readable regular file. |
| | `not_readable` | The package is declared and the file is absent or not readable, for example after the clone moved. |
| `questionExtension` | `not_declared` | No package of `settings.json` names the npm package of the extension. |
| | `declared` | `settings.json` names the package. No manifest of it is below `<dir>/npm/`. Pi did not install it yet. |
| | `installed` | The manifest `package.json` of the package exists below `<dir>/npm/node_modules/`. |
| `herdrCli` | `not_checked` | Always. `inventory` starts no process; use `check-herdr`. |
| `herdrSession` | `not_run` | Always. No kit action starts a Herdr session. |
| `questionUi` | `unverified` | Always. No kit action opens a question dialog. |

`installed` means that the file exists. It does not mean that Pi loads the extension. `readable` does not mean that Pi loads the skill.

### After a regeneration

A new candidate comes from the overlay. With `herdr` and `questions` in `selection.enable`, each regenerated candidate has the same two package entries. The regeneration writes into the new, absent target only. The old candidate, the active profile `~/.pi/agent`, the guidance file of the extension and the shared skill directories stay unchanged. Pi installs the question extension for each candidate on its own: `questionExtension` is `declared` until `pi update --extensions` ran for that candidate. See [the candidate update guide](guides/candidate-update.md).

### Live checks that the owner approves

These checks are not run by the kit and are not qualified. Record each as passed, failed, blocked or not run. Never record a check that did not run as passed.

| Check | Steps | Status |
| --- | --- | --- |
| The question dialog | Launch the candidate in an interactive terminal. Check that startup prints no extension error. Ask the agent for one question with two options. The dialog shows the options, and the answer reaches the agent. This check sends a model request. | Not run |
| The plain-text fallback | Run a session without the extension, or a session without a terminal. The agent asks in plain text with numbered options. | Not run |
| The temporary Herdr session | With the approval of the owner, start a named test session, read its state, stop it and delete it. Send no prompt to an agent, so that no model request starts. Remove only the session that the check created. | Not run |
| The remote install | Run the lines of `remote-plan` on a disposable Linux host that the owner approves. | Not run |

Facts for the temporary session, from `herdr --help` at version 0.9.3: `herdr --session <name>` uses or creates a named persistent session; `herdr session list` lists the sessions; `herdr session stop <name>` stops one; `herdr session delete <name>` deletes a stopped session. Not verified: the exact command sequence of a session check on a machine without a terminal. A missing terminal is a blocker for this check, not a pass. Do not stop or delete a session that the check did not create, and do not run `herdr server stop`.

## The remote plan

For an install on a remote Linux host, the `remote-plan` action prints the SSH command lines of the remote stages. It runs none of them.

```sh
python3 scripts/tenant_pi.py remote-plan --ssh-target build-host --remote-user deploy --remote-home /home/deploy
```

| Option | Rule |
| --- | --- |
| `--ssh-target <target>` | A host alias, a host name or an address, with an optional `<user>@`. No port, no option, no space: else `ssh_target: remote-plan.ssh_target`. A port or a jump host belongs to the SSH configuration of the user. |
| `--remote-user <name>` | The account that owns the install: else `remote_user: remote-plan.remote_user`. A target that names another account gives `ssh_user_mismatch: remote-plan.ssh_target`. |
| `--remote-home <path>` | The absolute home directory of that account: else `absolute_path: remote-plan.remote_home`. A path can hold spaces. |

The action starts no process, opens no file, and reads no environment value. It reads no SSH key, no SSH configuration and no credential. A diagnostic names the rule and the field only.

The output is one JSON object. `runs` is always `false`. `paths` holds the clone, the private directory, the profile and the Herdr configuration directory below the home. `stages` is an ordered list:

| Stage | Remote command | Changes the host |
| --- | --- | --- |
| `identity` | Compares the account name, `HOME` and the system name with the inputs. A wrong identity gives an exit code other than 0. | no |
| `home-owner` | `stat -c %U` of the home directory | no |
| `tools` | The versions of Node, npm, Python and Git | no |
| `herdr` | `command -v herdr && herdr --version` | no |
| `check-runtime` | The kit action in the remote clone | no |
| `check-herdr` | The kit action in the remote clone | no |
| `herdr-skill-files` | `test -r` of the `SKILL.md` of the bundled Herdr skill | no |
| `init-private` | The kit action with the private directory and the profile | yes |
| `plan` | The kit action with the overlay of the private directory | no |
| `generate` | The kit action with the overlay and the profile | yes |
| `inventory` | The kit action with the profile | no |

Each stage has `argv` and `display`. `argv` is the list `ssh`, `--`, the target, and one remote command. `display` is the same list as one line for a POSIX shell. A stage that changes the host has `"approval": "user_approval_required"`.

Rules of the lines:

- No line has an SSH option. The SSH configuration, the keys, the agent and the known hosts of the user stay in force. Host key verification is never turned off. `hostKeyChecking` is `unchanged`.
- `--` ends the SSH options, so the target is never read as an option.
- SSH gives the remote command to the login shell of the account as one string. The action quotes each argument for a POSIX shell. A path with a space, an apostrophe or a quotation mark stays one argument.
- No line installs or updates Herdr, creates an account, uses `sudo`, or runs the shared skill installer.

Limits:

- The plan has no clone step: the kit does not know the address of your copy of the repository.
- A remote command through SSH does not read the files of an interactive shell. Not verified: a Node from a version manager is on `PATH` for these lines.
- Not verified: a login shell that is not a POSIX shell.
- Offline tests run each line through a fake `ssh`. No test opens a connection. A remote install is not qualified: it needs a trial on a disposable Linux host that the owner approves.

## The question extension component

| Field | Value |
| --- | --- |
| Component ID | `questions` |
| Source | npm `@juicesharp/rpiv-ask-user-question@2.11.0` |
| License | MIT |
| Requires | `core` |
| Resource filter | `extensions`: `index.ts` |
| Status | `unverified` |
| Default | Disabled in `config/config.example.json` |

The registry metadata of version 2.11.0 was read: the name, the license, the one extension entry `./index.ts`, and the dependency lists. The source files of that version were not reviewed.

With `questions` in `selection.enable`, the plan does this:

- It adds one entry to `packages` of `settings.json`: the source `npm:@juicesharp/rpiv-ask-user-question@2.11.0` with the filter `extensions: ["index.ts"]`. The entry comes after the in-tree packages, the memory packages and the MCP package, and before owner packages.
- It adds two setup lines: `pi update --extensions` with the target directory, then `node scripts/patch_extension_peers.mjs`. Pi installs the package under `<target>/npm/`. The second line moves `typebox` to `peerDependencies` in the installed manifest; see [host peer overrides](host-peer-overrides.md).
- It writes no other file. The extension reads its guidance file below the configuration directory of the user. The kit does not write or check that file.

The plan lists these gaps with the subject `questions`:

| Gap | Fact |
| --- | --- |
| `package_runtime_unverified` | No session loaded the package from a generated profile. |
| `pi_line_unqualified` | No test in this repository loads the component with the kit pin. |
| `package_source_unreviewed` | Only the registry metadata of version 2.11.0 was read. |
| `peer_package_unverified` | The package names the peer package `@juicesharp/rpiv-i18n`. No install of version 2.11.0 with the kit pin was observed. |
| `question_ui_unverified` | The tool needs an interactive Pi session. A loaded extension does not prove that the question dialog works. |
| `shared_config_outside_profile` | The guidance file of the extension is outside the profile. Every profile of the user shares it. |
| `kit_test_missing` | No test in this repository loads the component in a generated profile. |

A setup step must not depend on the question tool. When no question tool is loaded, the agent asks in plain text.

The version is exact. `scripts/pi_update.py detect` compares it with the registry; see [the Pi update check](pi-update.md).
