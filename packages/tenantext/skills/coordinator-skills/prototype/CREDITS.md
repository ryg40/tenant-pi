# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/prototype/` (`SKILL.md`, `LOGIC.md`, `UI.md`) |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Adds one Herdr worker pane per ticket, with an isolated worktree and a throwaway branch that never merges.
- Selects the model and thinking level from the request or Herdr local defaults.
- Publishes branch pointers and decisions as Gitea ticket comments with the parent label.
- Routes HTML review through the artifact server, Walkr or `pidesktop`, not a local browser.
- Updates `LOGIC.md` handoff and review wording for Walkr and ticket comments. `UI.md` stays unchanged.
