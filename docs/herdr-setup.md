# Herdr and the question tool

Status: offline implementation, not a qualified runtime. This document gives the facts of two parts of a coordination setup: the Herdr application with its bundled skill, and the Pi question extension. The install steps are in [`INSTALL.md`](../INSTALL.md) and in the install skill.

## The parts

| Part | What it is | How the kit handles it |
| --- | --- | --- |
| Herdr application | A host tool: the `herdr` command and its server. It is not an npm package and not a package of a profile. | The kit does not install, update or start it. |
| Herdr skill | The skill directory `packages/tenantext/skills/herdr` of this kit. | The core install loads it in the profile, and `install.sh` links it into `~/.claude/skills`. The installer of the skill, `packages/tenantext/skills/herdr/install.sh`, is the separate option that also makes `~/.agents/skills/herdr`. |
| Question extension | The npm package `@juicesharp/rpiv-ask-user-question`. It gives Pi the `ask_user_question` tool. | The settings template declares it at the exact version of `config/manifest.json`. Pi installs it at the first start. |

The question extension is a Pi extension. Claude Code has its own question tool. The kit installs no Pi extension into Claude Code.

The third-party package `@ogulcancelik/pi-herdr` is not a part of this kit.

The component `herdr-watch` is a Pi extension of this kit. It waits on a Herdr pane in the background and delivers the reply as a task notification; see [its document](../packages/tenantext/docs/herdr-watch.md).

The skill `herdr-relay` and the extension `herdr-watch` find the scripts of the Herdr skill at `~/.agents/skills/herdr` first. `HERDR_SKILL_HOME` (relay) and `HERDR_SKILL_DIR` (watch) name another folder. Without that folder, the relay stops with an error; the watch falls back to the copy of the kit.

## The Herdr check

```sh
command -v herdr && herdr --version
```

The command prints the path and the version of the installed Herdr, or nothing. Do not install a second copy, and do not run `herdr update` as a part of the setup. A present command does not prove a running server, a working session or a loaded skill. The manifest names no required Herdr version.

## Verification results

Four results are separate. One result does not prove another. A present command and a loaded skill do not prove a working session or a working question tool.

| Result | How to get it | Values | Offline |
| --- | --- | --- | --- |
| Herdr command | `herdr --version` | the version, or no command | Runs one command. |
| Herdr skill in the profile | `scripts/pi_update.py qualify`, step `profile-load` | passed, failed | yes, with the Pi of the qualification |
| Interactive question dialog | An interactive Pi session of the profile, with the approval of the owner | passed, failed, not run | no: always `unverified` |
| Temporary Herdr session | A named test session, with the approval of the owner | passed, failed, blocked, not run | no: always `not_run` |

### Live checks that the owner approves

These checks are not run by the kit and are not qualified. Record each as passed, failed, blocked or not run. Never record a check that did not run as passed.

| Check | Steps | Status |
| --- | --- | --- |
| The question dialog | Start the profile in an interactive terminal. Check that startup prints no extension error. Ask the agent for one question with two options. The dialog shows the options, and the answer reaches the agent. This check sends a model request. | Not run |
| The plain-text fallback | Run a session without the extension, or a session without a terminal. The agent asks in plain text with numbered options. | Not run |
| The temporary Herdr session | With the approval of the owner, start a named test session, read its state, stop it and delete it. Send no prompt to an agent, so that no model request starts. Remove only the session that the check created. | Not run |

Facts for the temporary session, from `herdr --help` at version 0.9.5: `herdr --session <name>` uses or creates a named persistent session; `herdr session list` lists the sessions; `herdr session stop <name>` stops one; `herdr session delete <name>` deletes a stopped session. Not verified: the exact command sequence of a session check on a machine without a terminal. A missing terminal is a blocker for this check, not a pass. Do not stop or delete a session that the check did not create, and do not run `herdr server stop`.

## The question extension component

The entry `questions` of `config/manifest.json` describes the component, with its gaps. `config/settings.example.json` names the same spec.

The registry metadata of the pinned version was read: the name, the license, the one extension entry `./index.ts`, and the dependency lists. The source files of that version were not reviewed. The gap facts of `questions` in `config/manifest.json` name that version.

- Pi installs the package under `<profile>/npm/` at the first start that has network access. `pi update --extensions` does not move it, because the source has an exact version.
- The registry manifest of the pinned version lists `typebox` under `peerDependencies` with the range `*`, so the peer correction makes no change for this version; see [host peer overrides](host-peer-overrides.md).
- The kit writes no other file for it. The extension reads its guidance file below the configuration directory of the user. The kit does not write or check that file.

No session loaded the package from a profile of the kit. The pinned version accepts the inbound event `rpiv:ask-user:answer`, so another extension in the same Pi process can answer an open question dialog.

A setup step must not depend on the question tool. When no question tool is loaded, the agent asks in plain text.

The version is exact. `scripts/pi_update.py detect` compares it with the registry; see [the Pi update checks](pi-update.md#pin) for a move of the version.
