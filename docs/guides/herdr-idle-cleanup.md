# Clean up idle Herdr workspaces

The `herdr-idle-cleanup` skill finds the Herdr workspaces whose agents have finished, collects their final reports into one ranked handoff file, and closes those workspaces after your yes. A later session in the same repository gets the open entries of that handoff as an assessment when it starts.

The skill is a component of the kit: `herdr-idle-cleanup` (the skill) and `handoffs` (the Pi extension of the startup assessment). It needs the `herdr` command, Python 3 and the `herdr` skill next to it.

## What the cleanup does

| Step | Command | Changes |
| --- | --- | --- |
| Scan | `idle_cleanup.py scan` | Nothing in Herdr. It writes `scan.json`: one class for each workspace (`protected`, `blocked`, `active`, `unknown`, `idle`) with a reason. |
| Harvest | `idle_cleanup.py harvest` | It reads the final reply of each agent pane of an `idle` workspace, ranks the Dummies reports P1 to P3, and writes `<stamp>.md`, `<stamp>.json` and `index.json`. |
| Close plan | `idle_cleanup.py close` | Nothing. It prints `close` or `keep` for each workspace, with the keep reason. |
| Close | `idle_cleanup.py close --close --yes` | It closes each workspace of the plan, by workspace ID, after it writes the resume data (session file, pane, cwd) into `index.json`. |

The close step never closes your own workspace, a protected workspace, or a workspace that is `active`, `blocked` or `unknown`. A workspace whose panes changed after the scan also stays open.

## Run it ad hoc

In a Herdr pane, type the command:

| Agent | Command |
| --- | --- |
| Claude Code | `/herdr-idle-cleanup` |
| Pi and Pi-Bolt (`tenant-pi`, `bolt`) | `/herdr-idle-cleanup` |

The agent runs the scan, the harvest and the close plan. It shows the P1 entries and the workspaces that it can close, and then it asks you one question: close these workspaces, or not. Nothing closes before your yes.

In Pi the command is a prompt template of the tenantext package. You can also ask the agent in plain words, for example "clean up the idle Herdr workspaces".

## The handoff files

The files go to `~/.local/share/tenant-pi/handoffs/`. The directory has mode 0700, and each file mode 0600. The Markdown file starts with a priority index (P1 first), then gives one section for each workspace with the report text of each pane. A handoff holds report text only, never a transcript.

Each report is a snapshot of its time. Check the current state before you act on an entry.

## The startup assessment

When a `tenant-pi` or `bolt` session starts, the `handoffs` extension asks the skill for `open` entries of the repository of the session. Claude Code does the same through the `SessionStart` hook of the `tenantext` plugin. With a match, the agent checks the current state of up to 3 entries, says whether each one is still open, and gives one suggestion. Each assessed entry then has the state `presented`.

`/handoffs` lists the entries (this repository first) and sets a state:

```text
/handoffs
/handoffs show <id>
/handoffs ack <id>
/handoffs done <id>
/handoffs dismiss <id>
/handoffs reopen <id>
```

Task sessions that the `herdr` skill starts claim nothing.

`/herdr-idle off` stops the startup assessment in Pi and in Claude Code; `/herdr-idle on` starts it again, and `/herdr-idle` shows the state. The row `herdr-idle` of `/resources` in Pi reads and writes the same setting. `/herdr-idle-cleanup` and `/handoffs` work in both states.

## Publish a handoff

Publishing is a separate step that only you start:

```sh
python3 ~/.agents/skills/herdr-idle-cleanup/scripts/idle_cleanup.py publish <stamp>
python3 ~/.agents/skills/herdr-idle-cleanup/scripts/idle_cleanup.py publish <stamp> --upload
```

1. The script writes `<stamp>.html` beside the Markdown file. The page is self-contained: it has no script and loads no external file.
2. The script runs the secret scanner of the kit (`scripts/scan.sh`) on both files. A finding stops the step, and nothing is uploaded.
3. Only with `--upload` and a clean scan, the script uploads the HTML file to your artifact service and prints the slug, the share link and the expiry. It follows no redirect: a 3xx answer is a failed upload.

Warning: the share link opens the report text of your sessions. Treat it as confidential, and put it in no public file.

The scan runs at level `warn`: a secret finding stops the upload, and a host value such as a local path is only printed and counted, for example `scan: no secret finding (4 host-value warnings)`.

## Settings

The settings file is `${XDG_CONFIG_HOME:-~/.config}/herdr-idle-cleanup/settings.json`. Each key is optional.

| Key | Use | Default |
| --- | --- | --- |
| `idle_minutes` | The idle threshold. | 30 |
| `protected_workspaces` | Workspace names or IDs that never close. | none |
| `handoff_dir` | The handoff directory. | `~/.local/share/tenant-pi/handoffs` |
| `model_command` | An argv list for `harvest --summarize` and `--model-rank`. | none |
| `startup_assessment` | `all`, `p1` or `off`. `/herdr-idle off` writes `off` and keeps the value before it in `startup_assessment_before_off`. `/herdr-idle on` restores that value, or writes `all` when none is kept. | `all` |
| `startup_other_count` | Print the count of open entries of other repositories. | `false` |
| `secret_scan_command` | An argv list of another scanner for `publish`. | `scripts/scan.sh` of the kit |
| `publish_url` | The base URL of the artifact service. The upload API is in [the publication reference of `tracker-site`](../../packages/tenantext/skills/tracker-site/references/publication.md). | none |
| `publish_token_file` | The file that holds the bearer token of the service. | none |

An example for the upload:

```json
{
  "publish_url": "https://artifacts.example.invalid",
  "publish_token_file": "~/.config/herdr-idle-cleanup/artifact-token"
}
```

Give the token file the mode 0600. The script reads the token from the file and puts it only in the request header.

## Existing profiles

`install.sh --upgrade` keeps the filter lists of the tenantext entry of a profile. One time for each profile, it adds `skills/herdr-idle-cleanup`, `extensions/handoffs/index.ts` and `prompts/herdr-idle-cleanup.md`, each to its own list, where the list would not load them: a list with a plain entry, or any list of an entry with `autoload: false`. A missing key, `[]` and a list of only `!`, `+` or `-` entries stay as they are; see [How Pi reads a list](../resources.md#how-pi-reads-a-list). The file `kit-steps.json` of the profile records that step, so the next upgrade does not add the items again after you remove them. When that file is invalid, the upgrade stops; remove the file to run the steps again.

The full reference is in [the SKILL.md of the skill](../../packages/tenantext/skills/herdr-idle-cleanup/SKILL.md) and [the handoff schema](../../packages/tenantext/skills/herdr-idle-cleanup/references/handoff-schema.md).
