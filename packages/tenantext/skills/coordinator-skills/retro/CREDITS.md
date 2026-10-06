# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/retro/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Defaults to the last ten project sessions and adds OpenViking session lookup, project-key matching, and local-log fallbacks.
- Maps mechanical findings to checks and judgement rules to Herdr reviewer prompts, with steering guidance for both harnesses.
- Uses slopscore traces for tool cost and `slopscore-pr` only for the pull request section.
- Asks for acceptance in three-question rounds before creating Gitea issues with triage labels.
- Adds an OpenKnowledge handoff through `okknow` and skill-loading instructions for both harnesses.
