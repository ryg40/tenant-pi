# Credits

- Source: https://github.com/inkeep/open-knowledge-skills
- Upstream path: `skills/core/open-knowledge`
- Pinned commit: `776760f49d5b3b5c24921165b6c1ea17e8990fd5`
- Author: Inkeep
- Licence: MIT, copyright 2026 Inkeep.
- Licence text: `../../../licenses/open-knowledge-skills-MIT.txt`.

## Source comparison

- Fetch `SKILL.md` and all 16 files in `references/` directly from the pinned MIT repository.
- The shared licence text matches the pinned repository's `LICENSE` byte for byte.
- No installed project-local copy is used as a source or dependency.
- The GPL copy in `inkeep/open-knowledge` is excluded.

## Changes from the pin

- Replace em-dashes and en-dashes with hyphens, ellipses with three periods, and arrows with ASCII arrows.
- Replace middle dots with semicolons, section signs with the word "section", and the comparison symbol with `<=`.
- Replace the warning symbol with `Warning:`, tree drawing characters with ASCII characters, and menu separators with `>`.
- Reword the delegation warning in `SKILL.md` to use "another agent" and "delegation". Keep markdown exploration on MCP.
- Scope the description to initialized OpenKnowledge projects and configured content. Kit installation alone does not initialize a project.
- Make the opening of `references/setup.md` conditional on an initialized project instead of assuming one.
- Keep the upstream `name: open-knowledge`, tool contracts, commands and complete reference file set.
- Add this credits file and `agents/openai.yaml` for kit metadata. Upstream has neither file.
