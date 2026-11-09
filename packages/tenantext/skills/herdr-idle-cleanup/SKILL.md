---
name: herdr-idle-cleanup
description: Clean up idle Herdr workspaces - scan and classify every workspace (read-only), harvest the final reports of the idle agent panes into a ranked handoff under ~/.local, then close the idle ones after the user's yes. Use when the user asks which Herdr workspaces or panes are idle, finished, blocked or safe to close, asks to collect or rank the final reports of idle panes, asks to close idle workspaces, runs /herdr-idle-cleanup, asks about the startup assessment or /handoffs entries, or asks to publish a handoff. Works the same from Claude Code and from Pi.
---

# Herdr idle cleanup

One script does each step. `S` is the script of this skill:

```bash
S="<the folder of this SKILL.md>/scripts/idle_cleanup.py"
test "${HERDR_ENV:-}" = 1 || echo "not in Herdr"
```

Shell variables do not persist between tool calls: write the full path of the script in place of `$S` in each command.

`scan` and `close` need Herdr. When the check prints `not in Herdr`, tell the user, and run only `entries` or `publish`. The skill uses only the shell and these scripts, so it runs the same under Pi, Pi-Bolt and Claude Code. The `herdr` skill must sit next to this skill; `scan` and `close` import its scripts.

## The default run

The command `/herdr-idle-cleanup` in Pi and in Claude Code runs this section. When the check above prints `not in Herdr`, tell the user and stop. Run these steps in order. Each step reads the file that the step before it wrote. A step that exits with an error stops the run: show its `error:` line.

1. `python3 "$S" scan`. Done when it prints the table and `scan.json: <path>`. Give the user the class and the reason of each workspace that is not `protected`.
2. `python3 "$S" harvest`. Done when it prints `handoff: <path>` and the counts. Give the user the P1 lines of the priority index of that Markdown file, word for word.
3. `python3 "$S" close`. This is the plan: one row for each workspace, `close` or `keep` with a keep reason. It closes nothing. Show the user the `close` rows.
4. Ask the user one question: "Close these <n> workspaces?" With no `close` row, say that nothing can close, and stop.
5. Only after a yes to the plan that you showed: `python3 "$S" close --close --yes`. Done when it prints the counts line; give the user the `closed`, `keep` and `failed` rows. With any other answer, stop. The handoff stays.

The run is complete when the user has the P1 entries, the plan, and an answer to the question.

Pass each `--protect <workspace-name-or-id>` argument of the user or of the command (repeatable) to `scan` and to both `close` runs. Pass `--summarize` or `--model-rank` to `harvest` only when the user asks for a model summary or a model order; each one needs the setting `model_command` and sends report text to that command.

## What `scan` and `close` decide

`scan` gives each workspace one class. When more than one applies, the first class in this order wins.

| Class | When |
| --- | --- |
| `protected` | The workspace of the caller (from `HERDR_PANE_ID`, else `HERDR_WORKSPACE_ID`), or a workspace of the setting `protected_workspaces` or of `--protect`. The scan stops when it cannot name the caller's workspace. |
| `blocked` | A pane has the Herdr status `blocked`, or its screen shows a pending question or approval (`PENDING_QUESTION_PATTERNS` in the script). |
| `active` | An agent pane is `working`, its screen shows a background agent (`BACKGROUND_AGENT_PATTERNS`, such as `← 1 agent`), or its last activity is newer than the idle threshold. |
| `unknown` | No agent is detected, a status is not `idle` or `done`, a screen could not be read, or no last activity is known. |
| `idle` | Each agent pane is `idle` or `done`, with no pending question, and its last activity is older than the threshold (30 minutes). |

A workspace that the scan cannot prove idle is `unknown` or `blocked`, never `idle`. Last activity is a Herdr time field, else the modification time of the transcript or of the Pi session file.

`close` closes a workspace only when its class is `idle`, each agent pane has the record of its current final reply in `index.json`, a fresh read of Herdr still shows it `idle` with the same panes and no newer activity, and it is neither the caller's workspace nor protected. It closes by workspace ID, and it writes the resume data of each pane (session file, pane, cwd) into its record first.

| Keep reason | When |
| --- | --- |
| `active`, `blocked`, `unknown`, `protected` | The class in `scan.json`. `unknown` also when an agent pane has no transcript or session file to resume from. |
| `no handoff entry` | An agent pane has no record of its current final reply. Run `harvest` again. |
| `changed since the scan` | The fresh read shows a new or missing pane, a newer activity time or another class. |

A `failed` row (`read failed` or `close failed`) keeps its workspace open; the run goes on and exits with code 1.

## The handoff directory

`scan`, `harvest` and `close` write to `~/.local/share/tenant-pi/handoffs/`, or to the setting `handoff_dir`. The directory has mode 0700 and each file mode 0600.

| File | Writer | Holds |
| --- | --- | --- |
| `scan.json` | `scan` (`--out` names another path) | The classes of the last scan. |
| `<stamp>.md`, `<stamp>.json` | `harvest` | The ranked entries: the priority index first, then one section for each workspace. |
| `index.json` | `harvest`, `close`, `startup`, `entries` | One record for each entry, with its state: `open`, `presented`, `acknowledged`, `done`, `dismissed`. |
| `<stamp>.html` | `publish` | The HTML form of one handoff. |

Each write of `index.json` goes through the script under its lock. To change a state, run the script; write no file of this directory by hand. The fields, the rank rules (P1 to P3) and the lock are in [references/handoff-schema.md](references/handoff-schema.md).

Each report is a snapshot of its time. Check the current state (Git status and log, the named issue or service) before you act on an entry.

## Startup assessment and /handoffs

At the start of a Pi session (extension `handoffs`) and of a Claude Code session (the SessionStart hook), the kit runs `startup --cwd <session dir>`. It claims up to 3 `open` entries of the repository of the session and sets them to `presented`. The session then gets one assessment turn: check the current state of each entry, say whether it is still open, and give one suggestion. A task session (`HERDR_SKILL_SESSION=task`), a print-mode run and a Pi reload, new, resume or fork claim nothing. The match rule and the claim rule are in [references/handoff-schema.md](references/handoff-schema.md#startup-and-entries).

`/herdr-idle on|off|status` in Pi and in Claude Code runs `switch on|off|status` and sets `startup_assessment` for both harnesses; no argument means `status`. Off: `startup` claims nothing and prints nothing. `/herdr-idle-cleanup` and `/handoffs` work in both states. The row `herdr-idle` of `/resources` in Pi runs the same subcommand.

`/handoffs` in Pi and in Claude Code runs `entries`:

```bash
python3 "$S" entries list --cwd "$PWD"
python3 "$S" entries show <id>
python3 "$S" entries set <id> acknowledged|done|dismissed|open
```

`open` takes a `presented` entry back to `open` when its assessment did not arrive.

## Publish (only when the owner asks)

```bash
python3 "$S" publish <stamp or path of the .md file>
python3 "$S" publish <stamp or path of the .md file> --upload
```

`publish` writes `<stamp>.html` beside the Markdown file: one self-contained page, with no script and no external file. Then it runs the secret scanner of the kit on both files. With no scanner, a finding or a scanner error, it uploads nothing and exits with code 1. Without `--upload`, it stops after a clean scan and prints the paths and the scan result. With `--upload` and a clean scan, it makes one upload to the artifact service of the settings and prints the slug, the share link and the expiry.

Run `--upload` only when the owner asks for an upload of that handoff. Give the share link only to the owner; write it into no tracked file, issue or commit.

## Privacy

- A handoff holds the report text of each pane, never a transcript. `index.json` holds the path of the session file, not its content.
- The handoff stays in the private handoff directory. Nothing leaves the host unless the owner runs `publish --upload`.
- The token of the artifact service stays in its file and in the script process: never in argv, a log, an output file or the reply.

## Settings

An optional JSON file at `${XDG_CONFIG_HOME:-~/.config}/herdr-idle-cleanup/settings.json`. A flag wins over the file. A missing file is fine; an invalid file stops the script with its path and the reason.

| Key | Flag | Default |
| --- | --- | --- |
| `idle_minutes` | `scan --idle-minutes N` | 30 |
| `protected_workspaces` | `--protect <name-or-id>` (adds to the list) | none |
| `handoff_dir` | `scan --out <path of scan.json>` | `~/.local/share/tenant-pi/handoffs` |
| `model_command` | needed by `--summarize` and `--model-rank` | none |
| `startup_assessment` | `all`, `p1` or `off`. `/herdr-idle off` writes `off`; `/herdr-idle on` writes `all` after `off`, so set `p1` again after an off | `all` |
| `startup_other_count` | `true` or `false` | `false` |
| `secret_scan_command` | the scanner of `publish` | `scripts/scan.sh --level warn tree` of the kit, when the skill runs from a kit tree |
| `publish_url` | the base URL of the artifact service for `--upload` | none |
| `publish_token_file` | the file that holds the bearer token for `--upload` | none |

`model_command` and `secret_scan_command` are argv lists; the script runs them with no shell. `secret_scan_command` runs in a scratch Git repository that holds the two files, staged, and exit 0 means a clean scan. The script trusts this command as the owner set it: a command that always exits 0 passes each file. A copy of the skill outside a kit tree (the Claude Code plugin cache) has no kit scanner, so `publish` needs this setting there.
