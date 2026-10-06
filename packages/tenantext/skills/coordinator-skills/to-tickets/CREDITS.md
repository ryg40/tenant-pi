# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/to-tickets/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Replaces local ticket creation and generic tracker setup with Gitea issues and the repository tracker contract.
- Adds the knowledge read order, glossary lookup, and question-tool instructions for both harnesses.
- Uses parent labels for the parent relation; requires two-pass native dependencies, dependency read-back, and named links.
- Omits "Blocked by" from Gitea issue bodies because pass 2 records native edges; keeps the named-link fallback for trackers without native edges.
- Removes the ready label from the parent spec after publication and reports the frontier without starting workers.
- Uses optional snapshot exports with a directory created when absent; replaces the long dash in expand-contract.
