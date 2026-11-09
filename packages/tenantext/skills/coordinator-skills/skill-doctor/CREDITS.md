# Credits

This skill is copied for this kit from an upstream skill. Its text is the upstream text with the changes below.

| Item | Value |
| --- | --- |
| Upstream source | `warpdotdev/common-skills` (https://github.com/warpdotdev/common-skills) |
| Upstream path | `.agents/skills/skill-doctor/` |
| Upstream version | commit `8792394ff1b655e0af451b8fabb68ef0cfcbd208` |
| Licence | MIT |
| Copyright | 2026 Denver Technologies, Inc. |

The frontmatter `name` is the upstream one. The file `agents/openai.yaml` is new in this kit: the upstream skill has none. The upstream licence text and its copyright notice are in [`licenses/warp-common-skills-MIT.txt`](../../../licenses/warp-common-skills-MIT.txt) of this package. The changes are under the MIT licence of this package.

## Changes from the pinned upstream commit

- `SKILL.md`, step 5: removes the field `cta_url` from the `report.json` template.
- `SKILL.md`, step 6: removes the Warp Factories line from the closing summary.
- `scripts/render_report.py`: removes the sticky Warp Factories footer with its "Request access" link and its default URL, the two footer text constants, and the CSS rules and colour variables that serve only that footer. The "Share" button and the share image do not change.
- All Markdown files: replaces each long dash (U+2014) and the one en dash (U+2013), because the text check of the kit refuses them. A single long dash becomes a colon, a pair becomes parentheses, the dash before "recommended" becomes parentheses, the dash before "with no knock-on cost" becomes a comma, and the range "1 to 3" uses words. The other words do not change. The text check of the kit keeps the one line of the collector flag for child sessions as a protocol line.
- Leaves out the upstream test files `scripts/test_collect_sessions.py` and `scripts/test_render_report.py`. The kit does not run them.

## Left out of the public copy

The public copy of the kit leaves out `assets/pierre-diffs.js`, the minified `@pierre/diffs` bundle of the upstream report page, because the bundle carries no licence notice. Without it, `scripts/render_report.py` prints one warning and the report shows plain diffs. To restore the rich diffs, build the bundle in `warpdotdev/skill-doctor` with `pnpm build:diffs` and copy it to `assets/pierre-diffs.js`.

## Upstream attribution that stays

The Warp pixel mark (`assets/warp-pixel-icon.svg` and its copy in `scripts/render_report.py`) and the share-image stamp stay as upstream attribution, by the choice of the maintainer; the kit removed only the advert.
