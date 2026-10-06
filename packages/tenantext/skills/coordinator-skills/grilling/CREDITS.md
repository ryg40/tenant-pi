# Credits

The text of this skill is adapted for this kit from an upstream skill.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/productivity/grilling/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Limits each question round to three questions, with the recommended answer first.
- Adds question-tool instructions for both harnesses and a plain-text fallback without emoji.
- Uses direct reads for simple facts and Herdr scout panes for searches.
- Records decisions on tickets and maps; reserves OpenViking memory for standing user preferences.
