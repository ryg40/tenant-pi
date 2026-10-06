# Credits

The text of this skill is adapted for this kit from an upstream skill. The visual menu (pseudocode, call tree, component tree, file tree, Mermaid, diff) is the work of Dex Horthy.

| Item | Value |
| --- | --- |
| Upstream source | `humanlayer/skills` (https://github.com/humanlayer/skills) |
| Upstream path | `plugins/show-me/skills/show-me/SKILL.md` |
| Upstream version | 1.0.1, commit `ca7c808` |
| Licence | MIT |
| Author | Dex Horthy |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/humanlayer-skills-MIT.txt`](../../../licenses/humanlayer-skills-MIT.txt) of this package. The other skills of the component come from `mattpocock/skills`; its licence text is in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt). The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Adds Gitea comment support and a call to the `pr` skill for merge-record visuals.
- Replaces local browser opening with Walkr artifact publication or `pidesktop` review, and returns the artifact slug.
- Replaces the long dash in the HTML guidance with a colon.
