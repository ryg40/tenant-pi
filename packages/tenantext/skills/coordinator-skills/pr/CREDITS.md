# Credits

The **Summary** section's menu of visuals (pseudocode, call trees, component trees, file trees, Mermaid, diffs) and its placement guidance come from [Dex Horthy](https://github.com/dexhorthy)'s [`show-me`](https://github.com/humanlayer/humanlayer) skill, reproduced almost word for word and aimed at a diff instead of a live conversation. `pr` does not depend on `show-me` as a skill (a hard dependency would break standalone installs), so the content is copied in rather than pointed at; this file is the attribution a dependency would otherwise have carried.

## Kit credits

The text of this skill is adapted for this kit from an upstream skill. The paragraph above is the upstream credits note, without its statement that `show-me` is absent from the upstream repository. In this kit the `show-me` skill ships in the same component, and the menu stays copied in.

| Item | Value |
| --- | --- |
| Upstream source | `mattpocock/skills` (https://github.com/mattpocock/skills) |
| Upstream path | `skills/engineering/pr/SKILL.md` |
| Upstream version | 1.3.1, commit `6fd9479` |
| Licence | MIT |
| Visual menu | Dex Horthy, `humanlayer/skills` (https://github.com/humanlayer/skills), `plugins/show-me`, MIT |

The frontmatter `name` and the file `agents/openai.yaml` are the upstream ones. The upstream licence text and its copyright notice are in [`licenses/mattpocock-skills-MIT.txt`](../../../licenses/mattpocock-skills-MIT.txt) of this package. The licence text of the visual menu is in [`licenses/humanlayer-skills-MIT.txt`](../../../licenses/humanlayer-skills-MIT.txt). The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- Adds Gitea merge-record comments and pull request body updates through the tracker contract.
- Adds exact offline check output, history scan evidence, and a list of unproved claims.
- Extends Merge Danger with a release-gate table and publication risk guidance.
- Routes screenshots through `pidesktop` and distinguishes them from Walkr artifact review.
- Adds the `slopscore-pr` call and identifies Gitea Mermaid support.
