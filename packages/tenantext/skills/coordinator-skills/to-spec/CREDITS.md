# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/to-spec/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Replaces generic tracker setup with the Gitea tracker contract and stops when no tracker exists.
- Adds the OpenViking, OpenKnowledge through `okknow`, and Pi LLM-WIKI read order, with `GLOSSARY.md` read first.
- Adds question-tool instructions for both harnesses, up to three questions per round, and the `grilling` call.
- Publishes the spec as an issue, defines its triage-label handoff to `to-tickets`, and adds map parent labels.
- Adds the public-text rule for specs and forbids local spec files.
