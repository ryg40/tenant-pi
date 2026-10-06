# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/research/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Uses a new Herdr researcher pane and its reply as the result channel for each ticket.
- Selects the model and thinking level from the request or Herdr local defaults; requires a web search tool.
- Adds the OpenViking, OpenKnowledge through `okknow`, and Pi LLM-WIKI knowledge read order.
- Records findings in Gitea ticket comments or linked OpenKnowledge pages, rather than repository Markdown files.
