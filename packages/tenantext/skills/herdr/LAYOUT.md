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
| `coordinator` | Below the active coordinator pane. A handoff always goes down, never to the side and never to a new tab. |
| All other roles | First agent: the root pane of the new role tab. Next agents: a free pane that `spawn.py` made before, or a split of the largest pane in the tab. A wide pane splits to the right, all others split down. |

- The focus of the user does not move.
- `close.py` closes subagent panes of your workspace. It refuses coordinator panes, interactive sessions, and panes that `spawn.py` did not start.

## State

| Path | Content |
| --- | --- |
| `~/.local/state/herdr-skill/panes/<pane>.json` | One record for each pane that the skill named or started |
| `~/.local/state/herdr-skill/prompts/<name>.md` | The role prompt that the agent got at its start |
