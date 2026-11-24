# Layout and names

The scripts apply these rules. You do not set tabs, panes or names by hand.

## Names

| Thing | Pattern | Example |
| --- | --- | --- |
| Workspace | The project. The user sets it. | `Example-Workspace-2026` |
| Tab | `<role>` | `coordinator`, `researcher`, `scout`, `worker`, `reviewer` |
| Agent name | `<project>-<role>-<n>` | `example-workspace-scout-2` |
| Pane label | `<agent name> <harness>:<model>/<thinking>` | `example-workspace-scout-2 pi:example-model/xhigh` |

- `project` is the workspace label in lower case. Each character outside `a-z0-9` becomes `-`. It is cut to 17 characters, so that the name of each role has 32 characters or less and all names of a project start with the same word.
- `role` is the full role word. It is the same word as the `--role` input and the tab label.
- `n` starts at 1. A new agent gets the highest live number for its project and role, plus 1. For coordinators, `n` is the generation: `-2` took the handoff from `-1`.
- The agent name is the handle for `ask.py`, `last-reply.py` and `close.py`. It is unique on the Herdr server.
- The first word of a pane label is always the agent name. The second word is for the human reader.

## Tabs

| Rule | Detail |
| --- | --- |
| One tab for each role | All agents of a role in a workspace share the tab of that role. |
| Role tabs are first | Order: `coordinator`, `researcher`, `scout`, `worker`, `reviewer`. Tabs of the user stay behind them. |
| `coordinator` is tab 1 | Always. |
| First use | The first session that uses the skill in a workspace is the coordinator. Its tab gets the label `coordinator`, moves to position 1, and the session gets the name `<project>-coordinator-1`. |
| Made on demand | A role tab appears with the first agent of that role. It goes away when its last pane closes. |

## Panes

| Role | Where the new pane goes |
| --- | --- |
| `coordinator` | Below the active coordinator pane. A handoff always goes down, never to the side and never to a new tab. On herdr-core the label `herdr.split=down` asks the app for this place (section "On herdr-core"). |
| All other roles | First agent: the root pane of the new role tab. Next agents: on Herdr 1 a free pane that `spawn.py` made before, or a split of the largest pane in the tab. A wide pane splits to the right, all others split down. On herdr-core the label `herdr.split=auto` asks the app for the same split rule. The app reuses no free pane. |

- The focus of the user does not move.
- `close.py` closes task panes of your workspace. It refuses coordinator panes, interactive sessions, and panes that `spawn.py` did not start.

## On herdr-core

In a pane of the Herdr app the same names and one tab for each role apply. The core has spaces and tab IDs, not tab labels:

| Rule | Detail |
| --- | --- |
| Space | The label `herdr.space` of the caller's terminal. The scripts never choose a space by a name or a folder. |
| Project | The place that the app shows for the terminal (label `where`), else its folder. |
| Role tab | A coordinator goes into the tab of the caller. Each other role gets the tab ID `"tb" + md5("<space id>:<role>")`, so all agents of a role in a space share one tab. |
| Tab name | `spawn.py` sets the label `herdr.tab.name=<role>`. The app names a new tab after it and never renames a tab that exists. An app without this label shows a number. |
| First use | `init.py` makes the first caller of a space without a coordinator its coordinator: a record and the label `skill.role=coordinator`. Its name stays. The first tab holds the coordinator: a caller with no `skill.role` label and no role name whose `where` label ends in ` / 1` or ` / coordinator` becomes the coordinator at its first run, also when the space has one. A caller with a task role name is never claimed. |
| Coordinator name | The first coordinator has no terminal name and counts as number 1. A coordinator that a coordinator starts (a handoff) gets `<project>-coordinator-2`, then `-3`. |
| Handoff pane | The new coordinator of a handoff gets the label `herdr.split=down`. No other role gets this value. The app reads the label one time, when it places the pane. The value `down` puts the new pane below the target, with the same width; the app also knows `right`. The target is the pane of the parent terminal, the caller, when it is in the same tab, else the last pane of the tab. An older app ignores the label and puts the pane to the right of the last pane of the tab. |
| Role tab pane | Each role other than coordinator gets the label `herdr.split=auto`. The app splits the visible pane of the tab with the largest area, the first of equal panes. A wide pane splits to the right, all others split down. The parent does not matter. When a pane closes, its share goes back to the pane that it was split from. The label does not apply to the first pane of a new tab. An older app ignores the value and puts the pane to the right of the last pane of the tab. |
| Local only | The scripts list and count only the live terminals of this machine. An address with `/` (for example `fedora/t1`) is another machine. |

The core cannot order tabs, rename a tab that exists, or set the size of a pane. The label `herdr.split` gives the side of a new pane, and with `auto` also the target pane. A record counts on the core only when its `backend` is `herdr-core` and it is not older than its terminal: the core can give an address to a new terminal later.

For the scripts of the skill the record is the proof of the role; the label `skill.role` is a copy for other tools. When `hc label` fails after `init.py` wrote the record, the claim stays and `init.py` prints a warning. `init.py` has no lock: the first caller wins, and two calls at the same moment in one space can both claim, so run `init.py` one time for a space. When `hc get` of a listed terminal fails for another reason than not found, `init.py` and `panes.py` exit 1 and act on nothing. The TAB column of `panes.py` shows the role word on the core, and `<index>:<label>` on Herdr 1.

## State

| Path | Content |
| --- | --- |
| `~/.local/state/herdr-skill/panes/<pane>.json` | One record for each pane that the skill named or started |
| `~/.local/state/herdr-skill/prompts/<name>.md` | The role prompt that the agent got at its start |
