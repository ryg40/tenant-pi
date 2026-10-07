# Credits

- Source: https://github.com/inkeep/open-knowledge-skills
- Upstream path: `skills/core/open-knowledge-write-skill`
- Pinned commit: `776760f49d5b3b5c24921165b6c1ea17e8990fd5`
- Author: Inkeep
- Licence: MIT, copyright 2026 Inkeep.
- Licence text: `../../../licenses/open-knowledge-skills-MIT.txt`.

## Source comparison

- Both files in `references/` match the upstream bytes before adaptation.
- The installed `SKILL.md` differs in two places: Stage 8 and the scope reminder describe automatic copy refresh without its timing.
- Use the pinned upstream wording in both places: recorded, unedited copies refresh on watcher or server startup and can briefly lag.

## Changes from the pin

- Normalize long dashes, ellipses, arrows and the less-than-or-equal sign to ASCII in the skill and both references.
- Replace the delegated-agent example with a second agent session in Stage 4 and `references/pressure-testing.md`.
- Keep the upstream name, scope rules, tool examples and reference layout.
- Add this credits file and `agents/openai.yaml` for kit metadata. Upstream has neither file.
