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
- Adds OpenViking as the session source of Claude Code and Pi, with the local files as the source of the other harnesses and as the fallback:
  - `scripts/openviking_sessions.py` is new. It reads the Claude Code and Pi sessions from the OpenViking server of the OpenViking client configuration, with GET requests only and a deadline for each request (the reference names the waits outside it). It maps `--repo` to the peer IDs of the sessions, gives each message once and in order, and fails the run on a refused credential, another HTTP status that is not 5xx, a key or an identity that an HTTP header cannot carry, or a missing identity.
  - `scripts/collect_sessions.py`: the new flag `--source` (`auto`, `openviking`, `local`); the field `source` of each `sources` entry and the fields `session_source` and `session_source_note` of `inventory.json`; the output line `session source`; exit code 3 when no session is sampled. A local source block runs for each harness that OpenViking does not serve. A transcript of a session without tool output gets the header line `tool output: not available`, and its error count is `unknown` (`error_outputs` is null).
  - `SKILL.md`: the opening paragraph and Step 1 name the sources, the configuration layers and the error rule; Step 0 notes the project skills of an all-conversations run; Step 2 tells how to score a transcript without tool output; the new section "Run on a schedule".
  - `references/supported-harnesses.md`: the new section "Session sources".
  - `tests/test_openviking_source.py` is new: two tests of the kit for the OpenViking source and the fallback.
- `SKILL.md`, Step 2: replaces "in a single batch" with the scoring loop: one line in `scores.jsonl` for each transcript right after it is judged, a check with `scripts/next_unscored.py` after each line, and no end of the turn before `ALL SCORED`. A delegated scorer starts outside the scored repository.
- `scripts/next_unscored.py` is new. It prints the count scored, a note for a session ID with more than one line, and the next unscored transcript or `ALL SCORED`. With a list of transcript paths, it checks only those transcripts, for one batch scorer. It stops with one `error:` line on a malformed or non-UTF-8 `scores.jsonl`, a missing `transcripts` folder, or a listed path outside that folder.
- `scripts/render_report.py`: prints the letter grade and the overall percent on the line after the `report:` line. The page and the line use one grade, also when `report.json` has a null or empty `grade`.

## Left out of the public copy

The public copy of the kit leaves out `assets/pierre-diffs.js`, the minified `@pierre/diffs` bundle of the upstream report page, because the bundle carries no licence notice. Without it, `scripts/render_report.py` prints one warning and the report shows plain diffs. To restore the rich diffs, build the bundle in `warpdotdev/skill-doctor` with `pnpm build:diffs` and copy it to `assets/pierre-diffs.js`.

## Upstream attribution that stays

The Warp pixel mark (`assets/warp-pixel-icon.svg` and its copy in `scripts/render_report.py`) and the share-image stamp stay as upstream attribution, by the choice of the maintainer; the kit removed only the advert.
